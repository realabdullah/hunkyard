import {
  type Interaction,
  type Publication,
  PublishConfirmationSchema,
  PublishPreviewSchema,
  PullRequestRequestSchema,
  pullRequestLocation,
  redactSecrets,
} from '@hunkyard/domain';
import type { ReviewServiceDependencies } from './ports';

export const assertGitHubAccess = async (deps: ReviewServiceDependencies, consent: boolean) => {
  if (!consent) throw new Error('Explicit GitHub network consent is required.');
  if ((await deps.loadTarget(deps.root)).privacy === 'local-only')
    throw new Error(
      'GitHub network access is disabled in local-only mode. Change privacy mode explicitly first.',
    );
  if (!deps.github) throw new Error('GitHub integration unavailable.');
  return deps.github;
};
export const captureGitHub = async (
  deps: ReviewServiceDependencies,
  raw: unknown,
  exclusions: string[],
) => {
  const request = PullRequestRequestSchema.parse(raw);
  const github = await assertGitHubAccess(deps, request.allowGitHub);
  if ((await github.repository()).toLowerCase() !== request.repository.toLowerCase())
    throw new Error('PR repository does not match this checkout origin.');
  return github.capture(request, exclusions);
};
export const createPullRequestService = (
  deps: ReviewServiceDependencies,
  access: { writable(): void; serial<T>(operation: () => Promise<T>): Promise<T> },
) => {
  const read = async (id: string) => {
    if (!deps.store.interaction || !deps.store.saveInteraction)
      throw new Error('Durable interaction storage required.');
    return deps.store.interaction(id);
  };
  const save = async (state: Interaction) => {
    const expected = state.revision;
    state.revision += 1;
    await deps.store.saveInteraction?.(state, expected);
  };
  const session = async (id: string) => {
    const value = await deps.store.get(id);
    if (!value?.snapshot.pullRequest) throw new Error('GitHub PR session not found.');
    return value;
  };
  return {
    repository: async () => {
      if (!deps.github) throw new Error('GitHub integration unavailable.');
      return deps.github.repository(); // local Git config only; never invokes gh
    },
    context: async (id: string) => (await session(id)).snapshot.pullRequest,
    preview: (id: string, raw: unknown) =>
      access.serial(async () => {
        access.writable();
        const input = PublishPreviewSchema.parse(raw);
        const value = await session(id);
        if (value.runId !== input.runId || value.status !== 'completed')
          throw new Error('Publish only from the latest completed PR review.');
        const state = await read(id);
        if (state.revision !== input.revision)
          throw new Error('Interaction revision conflict. Reload before publishing.');
        const ids = [...new Set(input.findingIds)].sort();
        const existing = state.publications.find(
          (entry) => entry.runId === input.runId && entry.findingIds.join() === ids.join(),
        );
        if (existing) return existing;
        if (
          state.publications.some(
            (entry) =>
              entry.runId === input.runId &&
              entry.findingIds.some((findingId) => ids.includes(findingId)),
          )
        )
          throw new Error(
            'Some findings already have a publication preview or receipt. Reuse that preview.',
          );
        const findings = ids.map((findingId) => {
          const finding = value.findings.find((entry) => entry.id === findingId);
          if (!finding) throw new Error('Finding does not belong to this run.');
          const status =
            state.transitions
              .filter((entry) => entry.findingId === findingId && entry.runId === input.runId)
              .at(-1)?.to ?? finding.status;
          if (['fixed', 'dismissed', 'stale'].includes(status))
            throw new Error('Resolved or stale findings cannot be published.');
          return finding;
        });
        const pr = value.snapshot.pullRequest;
        if (!pr) throw new Error('Missing PR provenance.');
        const dedupeKeys = await Promise.all(
          findings.map(async (finding) => {
            const identity = JSON.stringify([
              pr.repository.toLowerCase(),
              pr.number,
              pr.headSha,
              finding.file,
              finding.side,
              finding.line,
              finding.title.trim().toLowerCase().replace(/\s+/g, ' '),
              finding.evidence.trim(),
            ]);
            const digest = await globalThis.crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(identity),
            );
            return Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, '0'),
            ).join('');
          }),
        );
        if (
          state.publications.some(
            (entry) =>
              entry.status !== 'preview' &&
              entry.dedupeKeys.some((key) => dedupeKeys.includes(key)),
          )
        )
          throw new Error(
            'Matching findings already have a publication attempt. Reuse its receipt; automatic repost is disabled.',
          );
        const publicationId = globalThis.crypto.randomUUID();
        const body = redactSecrets(
          [
            `Hunkyard local review of ${pr.headSha} (base ${pr.baseSha}; merge base ${pr.mergeBaseSha}).`,
            'AI-assisted findings for human assessment. This comment does not approve the PR or satisfy mandatory Qodo/organizational review.',
            ...findings.map((finding) => {
              const url = pullRequestLocation(value.snapshot, finding).sourceUrl;
              return `### ${finding.severity.toUpperCase()}: ${escapeMarkdown(finding.title)}\n[${escapeMarkdown(finding.file)}:${finding.line} (${finding.side})](${url})\n\n${escapeMarkdown(finding.explanation)}\n\nEvidence: ${escapeMarkdown(finding.evidence)}\n\nRecommendation: ${escapeMarkdown(finding.recommendation)}`;
            }),
            ...dedupeKeys.map((key) => `<!-- hunkyard-finding:${key} -->`),
            `<!-- hunkyard:${publicationId} -->`,
          ].join('\n\n'),
        );
        if (body.length > 60000)
          throw new Error('Publication exceeds 60000 characters; select fewer findings.');
        const publication: Publication = {
          id: publicationId,
          runId: input.runId,
          snapshotId: value.snapshot.id,
          repository: pr.repository,
          number: pr.number,
          headSha: pr.headSha,
          findingIds: ids,
          dedupeKeys,
          anchors: findings.map((finding) => ({
            findingId: finding.id,
            ...pullRequestLocation(value.snapshot, finding),
          })),
          body,
          status: 'preview',
          createdAt: new Date().toISOString(),
        };
        state.publications.push(publication);
        await save(state);
        return publication;
      }),
    publish: (id: string, publicationId: string, raw: unknown) =>
      access.serial(async () => {
        access.writable();
        const input = PublishConfirmationSchema.parse(raw);
        const github = await assertGitHubAccess(deps, input.allowGitHub);
        if (
          (await github.repository()).toLowerCase() !==
          (await session(id)).snapshot.pullRequest?.repository.toLowerCase()
        )
          throw new Error('PR repository no longer matches this checkout origin.');
        const value = await session(id);
        const state = await read(id);
        if (state.revision !== input.revision)
          throw new Error('Interaction revision conflict. Reload before publishing.');
        const publication = state.publications.find((entry) => entry.id === publicationId);
        if (!publication) throw new Error('Publication preview not found.');
        if (publication.status === 'published') return publication;
        const found = await github.findPublication(publication);
        if (found) {
          publication.status = 'published';
          publication.url = found;
          await save(state);
          return publication;
        }
        if (publication.status !== 'preview')
          throw new Error(
            'Publication outcome uncertain. Inspect GitHub manually; automatic repost is disabled.',
          );
        if (value.runId !== publication.runId || value.snapshot.id !== publication.snapshotId)
          throw new Error('Preview belongs to an old run. Create a preview from the latest run.');
        // Recheck decisions made after the preview was prepared.
        for (const findingId of publication.findingIds) {
          const finding = value.findings.find((entry) => entry.id === findingId);
          const status =
            state.transitions
              .filter((entry) => entry.findingId === findingId && entry.runId === publication.runId)
              .at(-1)?.to ?? finding?.status;
          if (!status || ['fixed', 'dismissed', 'stale'].includes(status))
            throw new Error('Finding state changed; publication refused.');
        }
        const current = await github.head(publication);
        const pr = value.snapshot.pullRequest;
        if (
          current.headSha !== publication.headSha ||
          current.baseSha !== pr?.baseSha ||
          current.state !== 'open'
        )
          throw new Error(
            'PR changed or closed since capture. Refresh and review before publishing.',
          );
        publication.status = 'publishing';
        await save(state); // A crash after here must never cause an automatic repost.
        try {
          publication.url = await github.publish(publication);
          publication.status = 'published';
        } catch {
          publication.status = 'uncertain';
          await save(state);
          throw new Error(
            'Publication outcome uncertain. Inspect GitHub; confirmation can recover a matching receipt but will never repost.',
          );
        }
        await save(state);
        return publication;
      }),
  };
};
const escapeMarkdown = (text: string) => text.replace(/[\\`*_{}[\]()#+.!<>|~-]/g, '\\$&');
