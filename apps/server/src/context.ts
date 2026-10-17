import { createHash } from 'node:crypto';
import { collectContext, projectSettings, type SemanticRetriever } from '@hunkyard/context';
import type {
  ContextManifest,
  ModelTarget,
  ReviewPolicyBundle,
  ReviewSnapshot,
} from '@hunkyard/domain';
import { runBytes, treeEntries } from '@hunkyard/git';

export const buildFrozenContext = async (
  snapshot: ReviewSnapshot,
  policy: ReviewPolicyBundle,
  target: ModelTarget,
  previous?: ContextManifest,
  semantic?: SemanticRetriever,
): Promise<ContextManifest> => {
  let unavailable = Boolean(snapshot.pullRequest);
  const entries = snapshot.pullRequest
    ? []
    : await treeEntries(snapshot.repoRoot, snapshot.indexTree).catch(() => {
        unavailable = true;
        return [];
      });
  const context = await collectContext(
    snapshot,
    policy,
    target,
    {
      entries,
      read: async (oid) => {
        try {
          const size = Number(
            (await runBytes(snapshot.repoRoot, ['cat-file', '-s', oid])).toString().trim(),
          );
          if (size > 100000) return null;
          const bytes = await runBytes(snapshot.repoRoot, ['cat-file', 'blob', oid]);
          return bytes.includes(0) ? null : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          return null;
        }
      },
    },
    (await projectSettings(snapshot.repoRoot)).contextBytes,
    semantic,
  );
  if (unavailable) {
    const paths = previous?.entries?.map((entry) => entry.path) ?? snapshot.files;
    for (const path of new Set(paths))
      context.omissions?.push({
        path,
        reason:
          'Frozen Git navigation tree unavailable (for example after pruning); retained changed sources remain reviewable',
      });
  }
  return context;
};

export const withSessionRules = (
  policy: ReviewPolicyBundle,
  rules: string[],
): ReviewPolicyBundle => {
  const text = rules.join('\n');
  const ruleHash = createHash('sha256').update(text).digest('hex');
  const bundle = {
    ...(policy.plugin ? { plugin: policy.plugin } : {}),
    version: policy.version,
    instructions: [...policy.instructions, `User-approved session rules:\n${text}`],
    sources: [
      ...policy.sources,
      {
        path: 'session://approved-rules',
        hash: ruleHash,
        truncated: false,
        format: 'session-approved',
        content: text,
      },
    ],
    exclusions: policy.exclusions,
    ...(policy.fileRules ? { fileRules: policy.fileRules } : {}),
    ...(policy.conflicts ? { conflicts: policy.conflicts } : {}),
    ...(policy.diagnostics ? { diagnostics: policy.diagnostics } : {}),
  };
  return { ...bundle, hash: createHash('sha256').update(JSON.stringify(bundle)).digest('hex') };
};
