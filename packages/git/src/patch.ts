import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { type PatchProposal, type ReviewSession } from '@reviewlab/domain';
import { git } from './commands';

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const safeFile = async (root: string, file: string) => {
  if ((await realpath(root)) !== root) throw new Error('Repository root changed.');
  const path = resolve(root, file);
  if (
    !path.startsWith(`${root}${sep}`) ||
    file.includes('\\') ||
    file.includes(':') ||
    file.split('/').some((part) => ['..', '.', '.git', '.reviewlab', ''].includes(part))
  )
    throw new Error('Unsafe patch path.');
  let current = root;
  for (const part of file.split('/')) {
    current = join(current, part);
    const stat = await lstat(current);
    if (
      stat.isSymbolicLink() ||
      (current === path ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
    )
      throw new Error('Patch refuses symlinks, hardlinks and non-regular files.');
  }
  if ((await realpath(path)) !== path) throw new Error('Patch path escaped its repository.');
  return path;
};
const frozen = (session: ReviewSession, file: string) => {
  const change = session.snapshot.changes.find((entry) => entry.newPath === file);
  const source = session.snapshot.sources.find((entry) => entry.oid === change?.newOid);
  if (
    !change ||
    change.binary ||
    !['100644', '100755'].includes(change.newMode ?? '') ||
    !source ||
    source.text === null ||
    session.snapshot.omissions?.some((entry) => entry.path === file)
  )
    throw new Error(
      'Patches require an included regular text file on the new side of the frozen snapshot.',
    );
  const bytes = Buffer.from(source.bytes, 'base64');
  if (bytes.length > 50000 || !bytes.equals(Buffer.from(source.text)))
    throw new Error('Patch source must be UTF-8 text under 50 KB.');
  return bytes;
};
export const createPatchAdapter = (root: string) => ({
  source: (session: ReviewSession, file: string) => frozen(session, file).toString(),
  prepare: async (session: ReviewSession, file: string, replacement: string) => {
    const before = frozen(session, file);
    if (replacement.includes('\0') || Buffer.byteLength(replacement) > 50000)
      throw new Error('Replacement must be UTF-8 text under 50 KB without NUL bytes.');
    if (replacement === before.toString()) throw new Error('Patch makes no change.');
    // An exact full-file hunk deliberately avoids fuzzy application or hidden context.
    const oldLines = before.toString().split('\n');
    const newLines = replacement.split('\n');
    const lines = (values: string[], prefix: string) =>
      values
        .map((line, index) =>
          index === values.length - 1 && line === '' ? '' : `${prefix}${line}\n`,
        )
        .join('') + (values[values.length - 1] === '' ? '' : '\\ No newline at end of file\n');
    return {
      baseHash: digest(before),
      preview: `--- a/${file}\n+++ b/${file}\n@@ -1,${oldLines.length - (oldLines[oldLines.length - 1] === '' ? 1 : 0)} +1,${newLines.length - (newLines[newLines.length - 1] === '' ? 1 : 0)} @@\n${lines(oldLines, '-')}${lines(newLines, '+')}`,
    };
  },
  describe: (session: ReviewSession, proposal: PatchProposal, isolated: boolean) =>
    isolated
      ? `Run git commit-tree ${session.snapshot.indexTree} to create an unreachable local commit object, then git worktree add --detach .reviewlab/experiments/${proposal.id} <object>. Disable checkout hooks, smudge/process filters, CRLF conversion and recursive submodules. Replace ${proposal.file} there and retain its backup. Your branch/index are preserved; no tests or push. Remove the worktree explicitly when finished.`
      : `Replace only ${proposal.file} in ${root}. Retain original bytes at ${proposal.file}.reviewlab-${proposal.id}.bak. Index is unchanged. The path may be briefly absent; editor-created replacements cause refusal.`,
  apply: async (session: ReviewSession, proposal: PatchProposal, isolated: boolean) => {
    const repository = await realpath(root);
    if (
      session.snapshot.repoRoot !== repository ||
      session.snapshot.id !== proposal.snapshotId ||
      digest(frozen(session, proposal.file)) !== proposal.baseHash
    )
      throw new Error('Patch provenance disagrees with its frozen snapshot.');
    let destination = repository;
    if (isolated && session.snapshot.pullRequest)
      throw new Error(
        'Remote PR snapshots cannot create a local experiment; use an explicitly prepared local checkout.',
      );
    if (isolated) {
      const parent = join(repository, '.reviewlab', 'experiments');
      for (const path of [join(repository, '.reviewlab'), parent]) {
        await mkdir(path, { recursive: true, mode: 0o700 });
        if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== path)
          throw new Error('Unsafe worktree directory.');
      }
      destination = join(parent, proposal.id);
      // commit-tree creates an unreachable local object; no branch or developer index is changed.
      const commit = (
        await git(
          root,
          '-c',
          'user.name=ReviewLab',
          '-c',
          'user.email=local@reviewlab.invalid',
          'commit-tree',
          session.snapshot.indexTree,
          '-m',
          'Approved ReviewLab isolated experiment',
        )
      ).trim();
      const hooks = join(parent, `${proposal.id}-disabled-hooks`);
      await mkdir(hooks, { mode: 0o700 });
      const filters = (
        await git(
          root,
          'config',
          '--name-only',
          '--get-regexp',
          '^filter\\..*\\.(smudge|process|required)$',
        ).catch(() => '')
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      const overrides = filters.flatMap((name) => [
        '-c',
        `${name}=${name.endsWith('.required') ? 'false' : ''}`,
      ]);
      await git(
        root,
        '-c',
        `core.hooksPath=${hooks}`,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.autocrlf=false',
        '-c',
        'submodule.recurse=false',
        ...overrides,
        'worktree',
        'add',
        '--detach',
        '--',
        destination,
        commit,
      );
    }
    const path = await safeFile(destination, proposal.file);
    if (digest(await readFile(path)) !== proposal.baseHash)
      throw new Error('File hash conflict. Recompute the proposal; current edits were preserved.');
    const backup = `${path}.reviewlab-${proposal.id}.bak`;
    const temp = `${path}.reviewlab-${proposal.id}.tmp`;
    const original = await lstat(path);
    const handle = await open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      original.mode & 0o777,
    );
    try {
      await handle.writeFile(proposal.replacement);
      await handle.sync();
    } finally {
      await handle.close();
    }
    let moved = false;
    let reserved = false;
    try {
      await safeFile(destination, proposal.file);
      // Reserve the backup name before moving, so a pre-existing backup is never replaced.
      const reserve = await open(backup, 'wx', 0o600);
      await reserve.close();
      reserved = true;
      await rename(path, backup);
      moved = true;
      const movedStat = await lstat(backup);
      if (
        !movedStat.isFile() ||
        movedStat.isSymbolicLink() ||
        movedStat.dev !== original.dev ||
        movedStat.ino !== original.ino ||
        digest(await readFile(backup)) !== proposal.baseHash
      )
        throw new Error('File changed during apply. Original remains in the backup.');
      if ((await realpath(dirname(path))) !== dirname(path))
        throw new Error('Parent directory changed during apply. Backup retained.');
      // Exclusive hardlink publication never replaces an editor-created destination.
      await link(temp, path);
      return { destination, backup };
    } catch (error) {
      if (moved) {
        try {
          await link(backup, path);
        } catch {
          /* A newer destination wins; preserve both files. */
        }
      } else if (reserved) {
        // The empty reservation is ours; if another process changed it, retain it.
        try {
          if ((await lstat(backup)).size === 0) await unlink(backup);
        } catch {
          /* Preserve uncertain state. */
        }
      }
      throw new Error(
        `${error instanceof Error ? error.message : 'Patch refused.'} Inspect ${backup} before retrying.`,
      );
    } finally {
      await unlink(temp);
    }
  },
});
