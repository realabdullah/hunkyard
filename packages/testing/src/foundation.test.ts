import { createHash } from 'node:crypto';
import { readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReviewService } from '@reviewlab/core';
import { captureStaged } from '@reviewlab/git';
import { createFileSessionStore } from '@reviewlab/storage';
import { describe, expect, test } from 'vitest';
import { createGitFixture, createReplayReviewer, fixtureSnapshot } from './index';

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

  test('fixture represents Unicode renames, deletion and symlinks', async () => {
    await withRepo(async ({ root, git }) => {
      await writeFile(join(root, 'delete.ts'), 'delete me\n');
      await git('add', '.');
      await git('commit', '-m', 'test: add deletion fixture');
      await rename(join(root, 'example.ts'), join(root, 'renamed ü.ts'));
      await unlink(join(root, 'delete.ts'));
      await symlink('renamed ü.ts', join(root, 'link.ts'));
      await git('add', '-A');
      const snapshot = await captureStaged(root);
      expect(snapshot.files).toEqual(['delete.ts', 'link.ts', 'renamed ü.ts']);
      expect(snapshot.diff).toContain('deleted file mode');
      expect(snapshot.diff).toContain('120000');
      expect(await git('show', `${snapshot.indexTree}:renamed ü.ts`)).toContain('value = 1');
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

test('review trace drives a persisted session without hosted credentials', async () => {
  await withRepo(async ({ root, git }) => {
    await writeFile(join(root, 'example.ts'), 'export const value = 2;\n');
    await git('add', '.');
    const snapshot = await captureStaged(root);
    const finding = {
      file: 'example.ts',
      line: 1,
      severity: 'major',
      title: 'Synthetic defect',
      explanation: 'Fixture explanation',
      evidence: 'value = 2',
      recommendation: 'Fixture recommendation',
    };
    const replay = createReplayReviewer([
      { diff: snapshot.diff, instructions: ['synthetic rule'], output: { findings: [finding] } },
    ]);
    const service = createReviewService({
      root,
      store: createFileSessionStore(root),
      agent: replay.agent,
      captureStaged: async () => snapshot,
      resolvePolicy: async () => ({
        version: 1,
        hash: createHash('sha256')
          .update(
            JSON.stringify({
              version: 1,
              instructions: ['synthetic rule'],
              sources: [],
              exclusions: [],
            }),
          )
          .digest('hex'),
        instructions: ['synthetic rule'],
        sources: [],
        exclusions: [],
      }),
      loadTarget: async () => ({
        provider: 'ollama',
        endpoint: 'http://127.0.0.1:11434',
        model: 'fixture',
        privacy: 'local-only',
        cloudConsent: false,
        repository: 'fixture',
        timeoutMs: 5000,
        maxTokens: 1000,
      }),
    });
    const session = await service.start();
    expect(session.status).toBe('queued');
    await service.execute(session.id);
    const completed = await service.get(session.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.findings[0]).toMatchObject(finding);
    expect(await createFileSessionStore(root).get(session.id)).toEqual(completed);
    replay.assertConsumed();
  });
});

test('replay refuses mismatched inputs, invalid output and unexpected calls', async () => {
  const input = {
    snapshot: fixtureSnapshot('expected'),
    instructions: [],
    exclusions: [],
    signal: new AbortController().signal,
    target: {
      provider: 'ollama' as const,
      endpoint: 'http://127.0.0.1:11434',
      model: 'fixture',
      privacy: 'local-only' as const,
      cloudConsent: false,
      repository: 'fixture',
      timeoutMs: 5000,
      maxTokens: 1000,
    },
  };
  const replay = createReplayReviewer([
    { diff: 'expected', instructions: [], output: { findings: [{ file: '../escape' }] } },
  ]);
  await expect(
    replay.agent.review({ ...input, snapshot: fixtureSnapshot('wrong') }),
  ).rejects.toThrow('mismatch');
  await expect(replay.agent.review(input)).rejects.toThrow();
  await expect(replay.agent.review(input)).rejects.toThrow('exhausted');
});
