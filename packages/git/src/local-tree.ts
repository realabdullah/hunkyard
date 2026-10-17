import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { excludedPath } from '@reviewlab/domain';
import { getRepoRoot, git, resolveCommit, runBytes, treeEntries } from './commands';

const absent = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
/** Never follows a symlinked ancestor; leaf links are captured as link text. */
const localBlob = async (root: string, path: string): Promise<string | null> => {
  const location = join(root, path);
  try {
    const parent = relative(await realpath(root), await realpath(dirname(location)));
    if (parent.startsWith('../') || parent === '..')
      throw new Error('Working source escapes repository root.');
    // Internal symlink ancestors also introduce ambiguous paths; refuse them.
    let cursor = root;
    for (const segment of path.split('/').slice(0, -1)) {
      cursor = join(cursor, segment);
      if ((await lstat(cursor)).isSymbolicLink())
        throw new Error('Working source has a symlink ancestor.');
    }
    const stat = await lstat(location);
    if (stat.isSymbolicLink())
      return (
        await runBytes(root, ['hash-object', '-w', '--stdin', '--no-filters'], {
          input: Buffer.from(await readlink(location)),
        })
      )
        .toString()
        .trim();
    if (!stat.isFile()) throw new Error('Working source is not a regular file.');
    const handle = await open(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Working source is not a regular file.');
      return (
        await runBytes(root, ['hash-object', '-w', '--stdin', '--no-filters'], {
          input: handle.createReadStream({ autoClose: false }),
        })
      )
        .toString()
        .trim();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
};

export const freezeLocalTree = async (
  root: string,
  indexTree: string,
  includeUntracked: boolean,
  paths: string[],
): Promise<{ tree: string; fingerprint: string }> => {
  const directory = await mkdtemp(join(tmpdir(), 'reviewlab-index-'));
  const index = join(directory, 'index');
  try {
    await runBytes(root, ['read-tree', indexTree], { index });
    const tracked = await treeEntries(root, indexTree);
    const trackMode =
      (await git(root, 'config', '--get', 'core.filemode').catch(() => 'true')).trim() !== 'false';
    const trackLinks =
      (await git(root, 'config', '--get', 'core.symlinks').catch(() => 'true')).trim() !== 'false';
    const untracked = includeUntracked
      ? (await git(root, 'ls-files', '--others', '--exclude-standard', '-z'))
          .split('\0')
          .filter((path) => Boolean(path) && !path.startsWith('.reviewlab/'))
      : [];
    const records = [
      ...tracked,
      ...untracked.map((path) => ({ path, mode: '100644', oid: '' })),
    ].filter((entry) => !paths.length || excludedPath(entry.path, paths));
    if (records.length > 20000)
      throw new Error('Working capture exceeds 20,000 paths. Use a staged/branch/range scope.');
    const updates: string[] = [];
    const fingerprint = createHash('sha256');
    for (const entry of records.sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
      let oid = '';
      let mode = entry.mode;
      if (entry.mode === '160000') {
        try {
          const nested = join(root, entry.path);
          if (
            (await lstat(nested)).isSymbolicLink() ||
            relative(await realpath(root), await realpath(nested)).startsWith('..')
          )
            throw new Error('Unsafe submodule path');
          if ((await realpath(await getRepoRoot(nested))) !== (await realpath(nested)))
            throw new Error('Uninitialized submodule');
          oid = await resolveCommit(nested, 'HEAD');
        } catch {
          oid = entry.oid;
        } // Missing/uninitialized submodule retains its index pointer.
      } else {
        const capturedOid = await localBlob(root, entry.path);
        if (capturedOid !== null) {
          const stat = await lstat(join(root, entry.path));
          mode =
            stat.isSymbolicLink() || (!trackLinks && entry.mode === '120000')
              ? '120000'
              : trackMode
                ? stat.mode & 0o111
                  ? '100755'
                  : '100644'
                : entry.mode;
          // Byte-exact working content: no clean filters, textconv, LFS downloads or CRLF normalization.
          oid = capturedOid;
        }
      }
      fingerprint.update(JSON.stringify([entry.path, mode, oid]));
      const record = oid
        ? `${mode} ${oid}\t${entry.path}\0`
        : `0 ${'0'.repeat(entry.oid.length || 40)}\t${entry.path}\0`;
      updates.push(record);
    }
    await runBytes(root, ['update-index', '-z', '--index-info'], {
      index,
      input: Buffer.from(updates.join('')),
    });
    return {
      tree: (await runBytes(root, ['write-tree'], { index })).toString().trim(),
      fingerprint: fingerprint.digest('hex'),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
