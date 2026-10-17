import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReviewService } from '@hunkyard/core';
import type { ModelTarget, PullRequestRequest } from '@hunkyard/domain';
import { capturePullRequest, captureStaged, runBytes } from '@hunkyard/git';
import { createGitHubProvider, type GitHubTransport } from '@hunkyard/providers';
import { createSqliteSessionStore } from '@hunkyard/storage';
import { createGitFixture } from './git-fixture';

export const request: PullRequestRequest = {
  repository: 'owner/repo',
  number: 12,
  allowGitHub: true,
};
export const setup = async (maliciousMarkdown = false) => {
  const fixture = await createGitFixture();
  await fixture.git('remote', 'add', 'origin', 'git@github.com:owner/repo.git');
  const base = (await fixture.git('rev-parse', 'HEAD')).trim();
  await writeFile(join(fixture.root, 'example.ts'), 'export const value = 2;\n');
  await fixture.git('add', 'example.ts');
  await fixture.git('commit', '-m', 'PR first head');
  const first = (await fixture.git('rev-parse', 'HEAD')).trim();
  await writeFile(join(fixture.root, 'example.ts'), 'export const value = 3;\n');
  await fixture.git('add', 'example.ts');
  await fixture.git('commit', '-m', 'PR new head');
  const second = (await fixture.git('rev-parse', 'HEAD')).trim();
  await writeFile(join(fixture.root, 'example.ts'), 'export const value = 7;\n');
  await fixture.git('add', 'example.ts');
  await writeFile(join(fixture.root, 'example.ts'), 'export const value = 8;\n');
  let remoteHead = first;
  let remoteState = 'open';
  let loseResponse = false;
  const published: { id: number; body: string; html_url: string; user: { login: string } }[] = [];
  const calls: { method: string; path: string }[] = [];
  const transport: GitHubTransport = async (method, path, body) => {
    calls.push({ method, path });
    if (method === 'POST') {
      const input = body as { body: string };
      const entry = {
        id: 500 + published.length,
        body: input.body,
        html_url: `https://github.com/owner/repo/pull/12#issuecomment-${500 + published.length}`,
        user: { login: 'reviewer' },
      };
      published.push(entry);
      if (loseResponse) throw new Error('lost reply');
      return { status: 201, headers: {}, data: entry };
    }
    let data: unknown;
    if (path.endsWith('/pulls/12'))
      data = {
        number: 12,
        html_url: 'https://github.com/owner/repo/pull/12',
        title: 'Fixture PR',
        body: 'Qodo must review this change.',
        state: remoteState,
        base: { sha: base, repo: { full_name: 'owner/repo' } },
        head: { sha: remoteHead },
      };
    else if (path.includes('/compare/')) data = { merge_base_commit: { sha: base } };
    else if (path.includes('/issues/12/comments')) data = published;
    else if (path.includes('/pulls/12/reviews'))
      data = [
        {
          id: 42,
          body: 'Mandatory review still required',
          html_url: 'https://github.com/owner/repo/pull/12#pullrequestreview-42',
          user: { login: 'qodo-code-review[bot]' },
          state: 'COMMENTED',
        },
      ];
    else if (path.includes('/pulls/12/comments'))
      data = [
        {
          id: 43,
          body: 'Original inline context',
          html_url: 'https://github.com/owner/repo/pull/12#discussion_r43',
          user: { login: 'reviewer' },
          path: 'example.ts',
          line: remoteHead === first ? 1 : null,
          side: 'RIGHT',
          commit_id: first,
        },
      ];
    else if (path.includes('/check-runs'))
      data = {
        total_count: 1,
        check_runs: [
          {
            name: 'Qodo external review',
            status: 'completed',
            conclusion: 'neutral',
            html_url: 'https://github.com/owner/repo/actions/runs/1',
          },
        ],
      };
    else if (path.includes('/statuses'))
      data = [
        {
          context: 'required-review',
          state: 'pending',
          target_url: 'https://example.com/external',
        },
      ];
    else throw new Error(`Unexpected fixture API: ${path}`);
    return { status: 200, headers: {}, data };
  };
  const github = createGitHubProvider(transport);
  const target: ModelTarget = {
    provider: 'ollama',
    model: 'fixture',
    endpoint: 'http://127.0.0.1:11434',
    repository: fixture.root,
    privacy: 'cloud-allowed',
    cloudConsent: false,
    timeoutMs: 1000,
    maxTokens: 1000,
  };
  const store = createSqliteSessionStore(fixture.root);
  const policy = { version: 1 as const, instructions: [], sources: [], exclusions: [] };
  const service = createReviewService({
    root: fixture.root,
    store,
    captureStaged,
    loadTarget: async () => target,
    resolvePolicy: async () => ({
      ...policy,
      hash: createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
    }),
    agent: {
      review: async ({ snapshot }) => [
        {
          file: 'example.ts',
          line: 1,
          side: 'new',
          severity: 'high',
          title: maliciousMarkdown
            ? 'Seeded issue ![pixel](https://evil.example/image)'
            : 'Seeded issue',
          explanation: 'A seeded defect for integration evidence',
          evidence:
            snapshot.sources
              .find((entry) => entry.oid === snapshot.changes[0]?.newOid)
              ?.text?.trim() ?? '',
          recommendation: 'Use the intended value.',
        },
      ],
    },
    github: {
      repository: async () => 'owner/repo',
      ...github,
      capture: async (input, exclusions) =>
        capturePullRequest(
          fixture.root,
          await github.read(input),
          exclusions,
          async (cwd, ...args) => {
            const effective =
              args[0] === 'fetch'
                ? [
                    'fetch',
                    '--no-tags',
                    '--depth=1',
                    fixture.root,
                    args.at(-1)?.startsWith('refs/pull/') ? remoteHead : (args.at(-1) ?? ''),
                  ]
                : args;
            return (await runBytes(cwd, effective)).toString('utf8');
          },
        ),
    },
  });
  const start = async () => {
    const initial = await service.startPullRequest(request);
    await service.execute(initial.id);
    const session = await service.get(initial.id);
    if (!session?.findings[0] || !session.runId) throw new Error('Fixture review failed.');
    return session;
  };
  return {
    ...fixture,
    base,
    first,
    second,
    service,
    store,
    calls,
    published,
    target,
    github,
    transport,
    start,
    move: () => {
      remoteHead = second;
    },
    restore: () => {
      remoteHead = first;
    },
    closePR: () => {
      remoteState = 'closed';
    },
    lose: () => {
      loseResponse = true;
    },
  };
};
