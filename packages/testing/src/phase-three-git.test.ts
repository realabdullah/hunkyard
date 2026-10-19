import * as fs from 'node:fs/promises';
import { chmod, mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { CaptureRequestSchema, changedLines } from '@hunkyard/domain';
import { captureSnapshot } from '@hunkyard/git';
import { validateSnapshot } from '@hunkyard/storage';
import { expect, test, vi } from 'vitest';
import { createGitFixture } from './git-fixture';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const fixtureTest = (
  name: string,
  run: (fixture: Awaited<ReturnType<typeof createGitFixture>>) => Promise<void>,
) =>
  test(name, async () => {
    const fixture = await createGitFixture();
    try {
      await run(fixture);
    } finally {
      await fixture.dispose();
    }
  });
const source = (
  snapshot: Awaited<ReturnType<typeof captureSnapshot>>,
  side: 'old' | 'new',
  path: string,
) => {
  const change = snapshot.changes.find(
    (entry) => (side === 'old' ? entry.oldPath : entry.newPath) === path,
  );
  return snapshot.sources.find(
    (entry) => entry.oid === (side === 'old' ? change?.oldOid : change?.newOid),
  )?.text;
};
fixtureTest(
  'unstaged uses index as base; combined uses HEAD; both preserve partial staging and immutable bytes',
  async ({ root, git }) => {
    await writeFile(join(root, 'example.ts'), 'export const value = 2;\n');
    await git('add', 'example.ts');
    await writeFile(join(root, 'example.ts'), 'export const value = 3;\r\n');
    const indexBefore = await git('ls-files', '--stage', '-z');
    const unstaged = await captureSnapshot(root, { kind: 'unstaged' });
    const combined = await captureSnapshot(root, { kind: 'working-tree' });
    expect(source(unstaged, 'old', 'example.ts')).toBe('export const value = 2;\n');
    expect(source(combined, 'old', 'example.ts')).toBe('export const value = 1;\n');
    expect(source(unstaged, 'new', 'example.ts')).toBe('export const value = 3;\r\n');
    expect(await git('ls-files', '--stage', '-z')).toEqual(indexBefore);
    expect(await readFile(join(root, 'example.ts'), 'utf8')).toBe('export const value = 3;\r\n');
    await writeFile(join(root, 'example.ts'), 'later edit\n');
    expect(source(combined, 'new', 'example.ts')).toContain('value = 3');
    validateSnapshot(unstaged);
    validateSnapshot(combined);
  },
);
fixtureTest(
  'untracked is opt-in, ignores Git ignored files and internal history, reports every unselected changed path',
  async ({ root, git }) => {
    await writeFile(join(root, '.gitignore'), 'ignored/\n');
    await git('add', '.gitignore');
    await git('commit', '-m', 'test: ignore');
    await mkdir(join(root, 'ignored'));
    await writeFile(join(root, 'ignored/key.txt'), 'ignored');
    await mkdir(join(root, '.hunkyard'));
    await writeFile(join(root, '.hunkyard/history.db'), 'internal');
    await writeFile(join(root, 'new ü.ts'), 'new code\n');
    await writeFile(join(root, 'example.ts'), 'working edit\n');
    expect((await captureSnapshot(root, { kind: 'working-tree' })).files).toEqual(['example.ts']);
    const snapshot = await captureSnapshot(root, {
      kind: 'unstaged',
      includeUntracked: true,
      paths: ['new*.ts'],
    });
    expect(snapshot.files).toEqual(['example.ts', 'new ü.ts']);
    expect(snapshot.omissions).toContainEqual({
      path: 'example.ts',
      reason: 'Outside selected paths',
    });
    expect(source(snapshot, 'new', 'new ü.ts')).toBe('new code\n');
    expect(snapshot.diff).not.toContain('working edit');
    validateSnapshot(snapshot);
  },
);
fixtureTest(
  'branch uses merge-base while commit-range uses exact endpoints, including detached HEAD and missing bases',
  async ({ root, git }) => {
    const baseline = (await git('rev-parse', 'HEAD')).trim();
    await git('checkout', '-b', 'feature');
    await writeFile(join(root, 'example.ts'), 'feature change\n');
    await git('add', '.');
    await git('commit', '-m', 'test: feature');
    const feature = (await git('rev-parse', 'HEAD')).trim();
    await git('checkout', 'main');
    await writeFile(join(root, 'main.ts'), 'main change\n');
    await git('add', '.');
    await git('commit', '-m', 'test: main');
    await git('checkout', '--detach', feature);
    const branch = await captureSnapshot(root, { kind: 'branch', baseRef: 'main' });
    expect(branch.baseTree).toBe((await git('rev-parse', `${baseline}^{tree}`)).trim());
    expect(branch.files).toEqual(['example.ts']);
    const range = await captureSnapshot(root, { kind: 'commit-range', from: 'main', to: feature });
    expect(range.files).toEqual(['example.ts', 'main.ts']);
    expect(range.changes.find((change) => change.oldPath === 'main.ts')?.status).toBe('D');
    await expect(captureSnapshot(root, { kind: 'branch', baseRef: '--evil' })).rejects.toThrow(
      'invalid commit',
    );
    await expect(captureSnapshot(root, { kind: 'commit-range', from: baseline })).rejects.toThrow(
      'requires from and to',
    );
    validateSnapshot(branch);
    validateSnapshot(range);
  },
);
fixtureTest(
  'binary/LFS/submodule/large/excluded files remain in the manifest with reasons and no reviewable anchors',
  async ({ root, git }) => {
    await mkdir(join(root, 'vendor'));
    await writeFile(join(root, 'vendor/code.ts'), 'vendor code\n');
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 255, 3]));
    await writeFile(
      join(root, 'asset.bin'),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 2000\n`,
    );
    await writeFile(join(root, 'large.ts'), 'x'.repeat(1_000_001));
    await writeFile(join(root, 'example.ts'), 'eligible code\n');
    await git('add', '.');
    await git(
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${(await git('rev-parse', 'HEAD')).trim()},module`,
    );
    const before = await git('status', '--porcelain=v1', '-z');
    const snapshot = await captureSnapshot(root, { kind: 'staged' }, ['vendor/**']);
    expect(snapshot.files).toHaveLength(6);
    expect(snapshot.omissions?.map((entry) => entry.path).sort()).toEqual([
      'asset.bin',
      'binary.dat',
      'large.ts',
      'module',
      'vendor/code.ts',
    ]);
    expect([...changedLines(snapshot).keys()]).toEqual(['old:example.ts', 'new:example.ts']);
    expect(await git('status', '--porcelain=v1', '-z')).toBe(before);
    validateSnapshot(snapshot);
  },
);
fixtureTest(
  'working modes, deletion, symlink target text and literal unusual paths survive capture',
  async ({ root, git }) => {
    await writeFile(join(root, 'script.sh'), '#!/bin/sh\nexit 0\n');
    await git('add', '.');
    await git('commit', '-m', 'test: executable');
    await chmod(join(root, 'script.sh'), 0o755);
    await unlink(join(root, 'example.ts'));
    await symlink('/outside/private/data', join(root, 'link'));
    const oddPath = process.platform === 'win32' ? 'literal ü spaces.ts' : ':(glob)* ü\t\n.ts';
    await writeFile(join(root, oddPath), 'literal path\n');
    const snapshot = await captureSnapshot(root, { kind: 'working-tree', includeUntracked: true });
    expect(snapshot.changes).toEqual(
      expect.arrayContaining([
        ...(process.platform === 'win32'
          ? []
          : [expect.objectContaining({ newPath: 'script.sh', newMode: '100755' })]),
        expect.objectContaining({ oldPath: 'example.ts', status: 'D' }),
        expect.objectContaining({ newPath: 'link', newMode: '120000' }),
      ]),
    );
    expect(source(snapshot, 'new', 'link')).toBe('/outside/private/data');
    expect(snapshot.files).toContain(oddPath);
    validateSnapshot(snapshot);
  },
);
fixtureTest(
  'rename plus replacement of its original path does not duplicate diff hunks',
  async ({ root, git }) => {
    await rename(join(root, 'example.ts'), join(root, 'renamed.ts'));
    await writeFile(join(root, 'example.ts'), 'replacement code\n');
    await git('add', '-A');
    const snapshot = await captureSnapshot(root, { kind: 'staged' });
    expect(snapshot.files).toEqual(['example.ts', 'renamed.ts']);
    expect(snapshot.diff.match(/^diff --git /gm)).toHaveLength(snapshot.changes.length);
    validateSnapshot(snapshot);
  },
);
fixtureTest(
  'merge conflicts and sparse working scope fail with actionable diagnostics; staged sparse remains usable',
  async ({ root, git }) => {
    const blob = (await git('rev-parse', 'HEAD:example.ts')).trim();
    const { runBytes } = await import('@hunkyard/git');
    await runBytes(root, ['update-index', '--index-info'], {
      input: Buffer.from(
        `0 ${'0'.repeat(40)}\texample.ts\n100644 ${blob} 1\texample.ts\n100644 ${blob} 2\texample.ts\n100644 ${blob} 3\texample.ts\n`,
      ),
    });
    await expect(captureSnapshot(root, { kind: 'unstaged' })).rejects.toThrow(
      'Unresolved merge conflicts',
    );
    await git('reset', '--mixed', 'HEAD');
    await git('config', 'core.sparseCheckout', 'true');
    await expect(captureSnapshot(root, { kind: 'working-tree' })).rejects.toThrow(
      'sparse checkout',
    );
    await writeFile(join(root, 'example.ts'), 'staged sparse\n');
    await git('add', '.');
    expect((await captureSnapshot(root)).diff).toContain('staged sparse');
  },
);
test('scope/path schemas refuse traversal, remote scopes, and implicit untracked inclusion in commit sources', () => {
  for (const input of [
    { kind: 'pull-request' },
    { paths: ['../private'] },
    { kind: 'staged', includeUntracked: true },
  ])
    expect(CaptureRequestSchema.safeParse(input).success).toBe(false);
});

fixtureTest(
  'working capture refuses repeated live mutations instead of assembling mixed versions',
  async ({ root }) => {
    // Edit the file each time capture opens it, so no two reads agree regardless of timing.
    const openMock = vi.mocked(fs.open);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let generation = 0;
    openMock.mockImplementation(async (path, ...rest) => {
      if (String(path).endsWith(`${sep}example.ts`))
        await writeFile(join(root, 'example.ts'), `export const generation = ${generation++};\n`);
      return actual.open(path, ...rest);
    });
    try {
      await expect(captureSnapshot(root, { kind: 'working-tree' })).rejects.toThrow(
        'changed repeatedly',
      );
      expect(generation).toBeGreaterThan(1);
    } finally {
      openMock.mockImplementation(actual.open);
    }
  },
);
fixtureTest(
  'working capture refuses a tracked directory redirected outside the repo without changing staging',
  async ({ root, git }) => {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/private.ts'), 'tracked safe\n');
    await git('add', '.');
    await git('commit', '-m', 'test: tracked directory');
    const before = await git('ls-files', '--stage', '-z');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const outside = await mkdtemp(join(tmpdir(), 'hunkyard-escape-'));
    try {
      await writeFile(join(outside, 'private.ts'), 'private outside bytes');
      await rm(join(root, 'src'), { recursive: true });
      await symlink(outside, join(root, 'src'), 'dir');
      await expect(captureSnapshot(root, { kind: 'working-tree' })).rejects.toThrow(
        'escapes repository',
      );
      expect(await git('ls-files', '--stage', '-z')).toBe(before);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  },
);
fixtureTest(
  'large working blobs stream safely and configured clean filters are never executed',
  async ({ root, git }) => {
    await writeFile(join(root, '.gitattributes'), '*.ts filter=forbidden\n');
    await git('add', '.gitattributes');
    await git('commit', '-m', 'test: filter attributes');
    await git('config', 'filter.forbidden.clean', 'hunkyard-forbidden-command');
    await git('config', 'filter.forbidden.required', 'true');
    await git('config', 'core.autocrlf', 'true');
    await writeFile(join(root, 'example.ts'), 'raw working bytes\r\n');
    await writeFile(join(root, 'large-working.ts'), 'x'.repeat(9 * 1024 * 1024));
    const snapshot = await captureSnapshot(root, { kind: 'working-tree', includeUntracked: true });
    expect(source(snapshot, 'new', 'example.ts')).toBe('raw working bytes\r\n');
    expect(snapshot.omissions).toContainEqual({
      path: 'large-working.ts',
      reason: 'Source retention budget (1 MB/file, 8 MiB/snapshot)',
    });
    validateSnapshot(snapshot);
  },
);
fixtureTest(
  'linked worktree working scopes use its own partial staging without touching the main index',
  async ({ root, git }) => {
    const worktree = join(root, 'linked ü worktree');
    await git('worktree', 'add', '-b', 'linked-scopes', worktree);
    await writeFile(join(worktree, 'example.ts'), 'staged worktree\n');
    await git('-C', worktree, 'add', 'example.ts');
    await writeFile(join(worktree, 'example.ts'), 'unstaged worktree\n');
    const mainIndex = await git('ls-files', '--stage', '-z');
    const snapshot = await captureSnapshot(worktree, { kind: 'unstaged' });
    expect(source(snapshot, 'old', 'example.ts')).toBe('staged worktree\n');
    expect(source(snapshot, 'new', 'example.ts')).toBe('unstaged worktree\n');
    expect(await git('ls-files', '--stage', '-z')).toBe(mainIndex);
    validateSnapshot(snapshot);
  },
);
