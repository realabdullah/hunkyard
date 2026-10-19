import { CaptureRequestSchema, type ReviewSnapshot } from '@hunkyard/domain';
import {
  canonicalRoot,
  type GitRunner,
  getRepoRoot,
  git,
  readHead,
  resolveCommit,
} from './commands';
import { freezeLocalTree } from './local-tree';
import { snapshotTrees } from './snapshot';

export type { GitRunner } from './commands';
export { getRepoRoot, runBytes, treeEntries } from './commands';

export const createStagedCapture =
  (run: GitRunner) =>
  async (cwd: string): Promise<ReviewSnapshot> => {
    const root = await canonicalRoot(run, cwd);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const head = await readHead(run, root);
      const tree = (await run(root, 'write-tree')).trim();
      if ((await readHead(run, root)) !== head) continue;
      const base = head
        ? (await run(root, 'rev-parse', `${head}^{tree}`)).trim()
        : (await run(root, 'mktree')).trim();
      return snapshotTrees(run, root, head, base, tree, CaptureRequestSchema.parse({}));
    }
    throw new Error(
      'HEAD changed repeatedly during staged capture. Retry when the repository is stable.',
    );
  };
export const captureStaged = createStagedCapture(git);
export const captureSnapshot = async (
  cwd: string,
  input: unknown = {},
  exclusions: string[] = [],
): Promise<ReviewSnapshot> => {
  const request = CaptureRequestSchema.parse(input);
  const root = await getRepoRoot(cwd);
  if (request.kind === 'branch' || request.kind === 'commit-range') {
    const to = await resolveCommit(root, request.kind === 'branch' ? 'HEAD' : (request.to ?? ''));
    const from = await resolveCommit(
      root,
      request.kind === 'branch' ? (request.baseRef ?? '') : (request.from ?? ''),
    );
    let base = from;
    if (request.kind === 'branch') {
      try {
        base = (await git(root, 'merge-base', from, to)).trim();
      } catch {
        throw new Error('Branch has no merge-base with the selected reference.');
      }
    }
    const snapshot = await snapshotTrees(
      git,
      root,
      to,
      (await git(root, 'rev-parse', `${base}^{tree}`)).trim(),
      (await git(root, 'rev-parse', `${to}^{tree}`)).trim(),
      request,
      exclusions,
    );
    snapshot.baseSha = base;
    snapshot.comparisonSha = from;
    return snapshot;
  }
  if (
    request.kind !== 'staged' &&
    (await git(root, 'config', '--get', 'core.sparseCheckout').catch(() => '')).trim() === 'true'
  )
    throw new Error(
      'Working scopes in sparse checkout require a full checkout; staged/branch/range scopes remain available.',
    );
  if ((await git(root, 'ls-files', '--unmerged', '-z')).length)
    throw new Error(
      'Unresolved merge conflicts. Resolve the index before capturing local changes.',
    );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const startHead = await readHead(git, root);
    const index = (await git(root, 'write-tree')).trim();
    const base = startHead
      ? (await git(root, 'rev-parse', `${startHead}^{tree}`)).trim()
      : (await git(root, 'mktree')).trim();
    if (request.kind === 'staged') {
      if ((await readHead(git, root)) !== startHead) continue;
      return snapshotTrees(git, root, startHead, base, index, request, exclusions);
    }
    const first = await freezeLocalTree(root, index, request.includeUntracked, []);
    const second = await freezeLocalTree(root, index, request.includeUntracked, []);
    if (
      first.fingerprint !== second.fingerprint ||
      (await readHead(git, root)) !== startHead ||
      (await git(root, 'write-tree')).trim() !== index
    )
      continue;
    const snapshot = await snapshotTrees(
      git,
      root,
      startHead,
      request.kind === 'unstaged' ? index : base,
      first.tree,
      request,
      exclusions,
    );
    snapshot.sourceIndexTree = index;
    snapshot.diagnostics?.push(
      'Working content captured byte-exactly; clean filters and CRLF normalization are disabled. Dirty submodule files and untracked .hunkyard/ internal state are outside this scope.',
    );
    return snapshot;
  }
  throw new Error('Working tree/index/HEAD changed repeatedly during capture. Retry when stable.');
};
export const stagedTreeIsCurrent = async (snapshot: ReviewSnapshot): Promise<boolean> =>
  snapshot.scope === 'staged' &&
  (await git(snapshot.repoRoot, 'write-tree')).trim() === snapshot.indexTree;
export { createPatchAdapter } from './patch';
export { capturePullRequest, githubRepository } from './pull-request';
