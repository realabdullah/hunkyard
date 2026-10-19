import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureStaged, createStagedCapture, type GitRunner } from '@hunkyard/git';
import { expect, test } from 'vitest';
import { createGitFixture } from './git-fixture';

const withFixture = async (
  run: (fixture: Awaited<ReturnType<typeof createGitFixture>>) => Promise<void>,
  options: { unborn?: boolean } = {},
) => {
  const fixture = await createGitFixture(options);
  try {
    await run(fixture);
  } finally {
    await fixture.dispose();
  }
};

test('first staged capture uses an empty base tree and preserves the unborn index', async () => {
  await withFixture(
    async ({ root, git }) => {
      const before = await git('status', '--porcelain=v1', '-z');
      const snapshot = await captureStaged(root);
      expect(snapshot.headSha).toBeNull();
      expect(await git('ls-tree', snapshot.baseTree)).toBe('');
      expect(snapshot.diff).toContain('+export const value = 1;');
      expect(snapshot.changes).toEqual([
        {
          status: 'A',
          oldPath: null,
          newPath: 'example.ts',
          oldMode: null,
          newMode: '100644',
          oldOid: null,
          newOid: (await git('rev-parse', `${snapshot.indexTree}:example.ts`)).trim(),
          binary: false,
        },
      ]);
      expect(await git('status', '--porcelain=v1', '-z')).toBe(before);
      expect(snapshot.diffHash).toBe(createHash('sha256').update(snapshot.diff).digest('hex'));
    },
    { unborn: true },
  );
});

test('index mutation immediately after write-tree cannot change captured diff or manifest', async () => {
  await withFixture(async ({ root, git }) => {
    await writeFile(join(root, 'example.ts'), 'export const value = 2;\n');
    await git('add', 'example.ts');
    const capturedTree = (await git('write-tree')).trim();
    let mutated = false;
    const runGit: GitRunner = async (_cwd, ...args) => {
      const result = await git(...args);
      if (args[0] === 'write-tree' && !mutated) {
        mutated = true;
        await writeFile(join(root, 'example.ts'), 'export const value = 3;\n');
        await writeFile(join(root, 'later.ts'), 'later staged content\n');
        await git('add', '.');
      }
      return result;
    };
    const snapshot = await createStagedCapture(runGit)(root);
    expect(mutated).toBe(true);
    expect(snapshot.indexTree).toBe(capturedTree);
    expect(snapshot.files).toEqual(['example.ts']);
    expect(snapshot.diff).toContain('+export const value = 2;');
    expect(snapshot.diff).not.toContain('value = 3');
    expect(snapshot.changes[0]?.newOid).toBe(
      (await git('rev-parse', `${capturedTree}:example.ts`)).trim(),
    );
    expect(await readFile(join(root, 'example.ts'), 'utf8')).toContain('value = 3');
    expect(await git('show', ':later.ts')).toBe('later staged content\n');
  });
});

test('HEAD movement during capture retries and repeated movement fails with a bounded diagnostic', async () => {
  await withFixture(async ({ root, git }) => {
    await writeFile(join(root, 'example.ts'), 'staged content\n');
    await git('add', '.');
    let captures = 0;
    const capture = createStagedCapture(async (_cwd, ...args) => {
      const result = await git(...args);
      if (args[0] === 'write-tree' && captures++ === 0)
        await git('commit', '--allow-empty', '-m', 'test: move HEAD');
      return result;
    });
    // The concurrent commit consumed the staged change; retry must not report the old base.
    await expect(capture(root)).rejects.toThrow('No staged changes');
    expect(captures).toBe(2);

    captures = 0;
    const unstable = createStagedCapture(async (_cwd, ...args) => {
      const result = await git(...args);
      if (args[0] === 'write-tree') {
        captures += 1;
        await git('commit', '--allow-empty', '-m', `test: move HEAD ${captures}`);
      }
      return result;
    });
    await expect(unstable(root)).rejects.toThrow('HEAD changed repeatedly');
    expect(captures).toBe(3);
  });
});

test('manifest preserves unusual paths, binary markers, executable modes and submodule OIDs', async () => {
  await withFixture(async ({ root, git }) => {
    const oddPath = process.platform === 'win32' ? 'renamed ü spaces.ts' : 'renamed ü\tline\n.ts';
    await rename(join(root, 'example.ts'), join(root, oddPath));
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 255, 1]));
    await writeFile(join(root, 'script.sh'), '#!/bin/sh\nexit 0\n');
    await chmod(join(root, 'script.sh'), 0o755);
    await git('config', 'core.filemode', 'true');
    const headSha = (await git('rev-parse', 'HEAD')).trim();
    await git('add', '-A');
    if (process.platform === 'win32') await git('update-index', '--chmod=+x', 'script.sh');
    await git('update-index', '--add', '--cacheinfo', `160000,${headSha},module`);
    const before = await git('status', '--porcelain=v1', '-z');
    const snapshot = await captureStaged(root);
    expect(snapshot.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'R', oldPath: 'example.ts', newPath: oddPath }),
        expect.objectContaining({ newPath: 'binary.dat', binary: true }),
        expect.objectContaining({ newPath: 'script.sh', newMode: '100755' }),
        expect.objectContaining({ newPath: 'module', newMode: '160000', newOid: headSha }),
      ]),
    );
    expect(await git('status', '--porcelain=v1', '-z')).toBe(before);
    await mkdir(join(root, 'nested'));
    expect((await captureStaged(join(root, 'nested'))).repoRoot).toBe(snapshot.repoRoot);
  });
});

test('detached HEAD works and corrupt HEAD is not treated as an unborn repository', async () => {
  await withFixture(async ({ root, git }) => {
    await git('checkout', '--detach');
    await writeFile(join(root, 'example.ts'), 'detached edit\n');
    await git('add', '.');
    expect((await captureStaged(root)).headSha).toBe((await git('rev-parse', 'HEAD')).trim());
    await writeFile(join(root, '.git', 'HEAD'), 'broken reference\n');
    await expect(captureStaged(root)).rejects.toThrow();
  });
});

test('linked worktree with spaces and Unicode captures its own index and shared repository identity', async () => {
  await withFixture(async ({ root, git }) => {
    // Windows strips a trailing space from directory names.
    const name = process.platform === 'win32' ? 'worktree ü' : 'worktree ü ';
    const worktree = join(root, name);
    await git('worktree', 'add', '-b', 'fixture-worktree', worktree);
    await writeFile(join(worktree, 'example.ts'), 'worktree staged\n');
    await git('-C', worktree, 'add', 'example.ts');
    const snapshot = await captureStaged(worktree);
    expect(snapshot.repoRoot.endsWith(name)).toBe(true);
    expect(snapshot.repositoryGitDir).toBe(
      (await git('rev-parse', '--path-format=absolute', '--git-common-dir')).replace(/\n$/, ''),
    );
    expect(snapshot.diff).toContain('+worktree staged');
    expect(await git('diff', '--cached')).toBe('');
  });
});

test('capture reports oversized changed files without silently dropping metadata', async () => {
  await withFixture(async ({ root, git }) => {
    await writeFile(join(root, 'large.txt'), 'x'.repeat(350_001));
    await git('add', 'large.txt');
    const snapshot = await captureStaged(root);
    expect(snapshot.files).toEqual(['large.txt']);
    expect(snapshot.diff).toBe('');
    expect(snapshot.omissions).toEqual([
      { path: 'large.txt', reason: 'Diff budget (350 KB/snapshot)' },
    ]);
  });
});
