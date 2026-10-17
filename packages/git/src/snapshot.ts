import { createHash, randomUUID } from 'node:crypto';
import {
  type CaptureRequest,
  diffSections,
  excludedPath,
  type ReviewSnapshot,
} from '@hunkyard/domain';
import { type GitRunner, runBytes } from './commands';
import { parseChanges } from './manifest';

export const snapshotTrees = async (
  run: GitRunner,
  root: string,
  headSha: string | null,
  baseTree: string,
  indexTree: string,
  request: CaptureRequest,
  exclusions: string[] = [],
): Promise<ReviewSnapshot> => {
  const diffArgs = [
    '--literal-pathspecs',
    '-c',
    'core.quotePath=true',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--no-relative',
    '--ignore-submodules=none',
    `--find-renames=${request.renameThreshold}%`,
    '--diff-algorithm=myers',
    '--no-indent-heuristic',
    '--full-index',
  ];
  const raw = await run(root, ...diffArgs, '--raw', '--no-abbrev', '-z', baseTree, indexTree, '--');
  const numstat = await run(
    root,
    ...diffArgs,
    '--no-renames',
    '--numstat',
    '-z',
    baseTree,
    indexTree,
    '--',
  );
  const changes = parseChanges(raw, numstat);
  if (!changes.length)
    throw new Error(`No ${request.kind === 'staged' ? 'staged' : request.kind} changes to review.`);
  const omissions: NonNullable<ReviewSnapshot['omissions']> = [];
  const sources: ReviewSnapshot['sources'] = [];
  const diagnostics: string[] = [];
  let retainedBytes = 0;
  let diff = '';
  for (const change of changes) {
    const path = change.newPath ?? change.oldPath;
    if (!path) throw new Error('Git change has no path.');
    let reason = '';
    if (
      request.paths.length &&
      ![change.oldPath, change.newPath].some((p) => excludedPath(p, request.paths))
    )
      reason = 'Outside selected paths';
    else if ([change.oldPath, change.newPath].some((p) => excludedPath(p, exclusions)))
      reason = 'Explicit project exclusion';
    else if (change.oldMode === '160000' || change.newMode === '160000')
      reason = 'Submodule pointer; nested content is not part of this snapshot';
    else if (change.binary) reason = 'Binary source; no text review';
    const retained: ReviewSnapshot['sources'] = [];
    if (!reason) {
      for (const oid of new Set([change.oldOid, change.newOid])) {
        if (!oid || sources.some((source) => source.oid === oid)) continue;
        const size = Number((await run(root, 'cat-file', '-s', oid)).trim());
        if (
          !Number.isSafeInteger(size) ||
          size > 1_000_000 ||
          size +
            retainedBytes +
            retained.reduce((n, s) => n + Buffer.from(s.bytes, 'base64').length, 0) >
            8 * 1024 * 1024
        ) {
          reason = 'Source retention budget (1 MB/file, 8 MiB/snapshot)';
          break;
        }
        const bytes = await runBytes(root, ['cat-file', 'blob', oid]);
        let text: string | null = null;
        try {
          if (!bytes.includes(0)) text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          /* Invalid UTF-8 is binary. */
        }
        if (text === null) {
          reason = 'Binary or non-UTF-8 source';
          break;
        }
        if (/^version https:\/\/git-lfs.github.com\/spec\/v1\r?\n/.test(text)) {
          reason = 'LFS pointer; object content is not downloaded';
          break;
        }
        retained.push({ oid, bytes: bytes.toString('base64'), text });
      }
    }
    if (!reason) {
      const rawPatch = await run(
        root,
        ...diffArgs,
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '--submodule=short',
        '--unified=5',
        baseTree,
        indexTree,
        '--',
        ...new Set([change.oldPath, change.newPath].filter((p): p is string => p !== null)),
      );
      const patch = diffSections({ diff: rawPatch, changes })
        .filter(
          (section) => section.oldPath === change.oldPath && section.newPath === change.newPath,
        )
        .map((section) => section.text)
        .join('');
      if (Buffer.byteLength(diff + patch) > 350_000) reason = 'Diff budget (350 KB/snapshot)';
      else {
        diff += patch;
        for (const source of retained) {
          sources.push(source);
          retainedBytes += Buffer.from(source.bytes, 'base64').length;
        }
        if (change.oldMode === '120000' || change.newMode === '120000')
          diagnostics.push(`${path}: symlink target text only; never dereferenced`);
      }
    }
    if (reason) omissions.push({ path, reason });
  }
  return {
    version: 2,
    id: randomUUID(),
    scope: request.kind,
    capture: request,
    omissions,
    diagnostics,
    repoRoot: root,
    repositoryGitDir: (
      await run(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    ).replace(/\n$/, ''),
    headSha,
    baseTree,
    indexTree,
    diff,
    diffHash: createHash('sha256').update(diff).digest('hex'),
    files: changes.map((change) => (change.newPath ?? change.oldPath) as string),
    changes,
    sources,
    gitVersion: (await run(root, '--version')).trim(),
    createdAt: new Date().toISOString(),
  };
};
