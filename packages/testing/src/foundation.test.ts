import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureStaged } from '@hunkyard/git';
import { describe, expect, test } from 'vitest';
import { createGitFixture } from './git-fixture';

const withRepo = async (
  run: (fixture: Awaited<ReturnType<typeof createGitFixture>>) => Promise<void>,
) => {
  const fixture = await createGitFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.dispose();
  }
};

describe('Git snapshot baseline', () => {
  test('partial staging excludes unstaged and untracked content without modifying either', async () => {
    await withRepo(async ({ root, git }) => {
      await writeFile(join(root, 'example.ts'), 'export const value = 2;\n');
      await git('add', '--', 'example.ts');
      await writeFile(join(root, 'example.ts'), 'export const value = 3;\n');
      await writeFile(join(root, 'untracked.ts'), 'private untracked content\n');
      const before = await git('status', '--porcelain=v1', '-z');
      const snapshot = await captureStaged(root);
      expect(snapshot.diff).toContain('+export const value = 2;');
      expect(snapshot.diff).not.toContain('value = 3');
      expect(snapshot.files).toEqual(['example.ts']);
      expect(await git('show', `${snapshot.indexTree}:example.ts`)).toBe(
        'export const value = 2;\n',
      );
      expect(await readFile(join(root, 'example.ts'), 'utf8')).toContain('value = 3');
      expect(await git('status', '--porcelain=v1', '-z')).toBe(before);
    });
  });

  test('empty index and unresolved merge conflict refuse capture', async () => {
    await withRepo(async ({ root, git }) => {
      await expect(captureStaged(root)).rejects.toThrow('No staged changes');
      await git('checkout', '-b', 'other');
      await writeFile(join(root, 'example.ts'), 'other\n');
      await git('commit', '-am', 'test: other branch');
      await git('checkout', 'main');
      await writeFile(join(root, 'example.ts'), 'main\n');
      await git('commit', '-am', 'test: main branch');
      await expect(git('merge', 'other')).rejects.toThrow();
      await expect(captureStaged(root)).rejects.toThrow();
    });
  });
});
