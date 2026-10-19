import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReviewService } from '@hunkyard/core';
import type { ModelTarget } from '@hunkyard/domain';
import { captureSnapshot, captureStaged } from '@hunkyard/git';
import { createSqliteSessionStore } from '@hunkyard/storage';
import { expect, test } from 'vitest';
import { createGitFixture } from './git-fixture';

const setup = async () => {
  const fixture = await createGitFixture();
  await writeFile(join(fixture.root, 'example.ts'), 'export const value = 2;\n');
  await fixture.git('add', 'example.ts');
  const target: ModelTarget = {
    provider: 'ollama',
    model: 'fixture',
    endpoint: 'http://127.0.0.1:11434',
    repository: fixture.root,
    privacy: 'local-only',
    cloudConsent: false,
    timeoutMs: 1000,
    maxTokens: 1000,
  };
  const policy = { version: 1 as const, instructions: [], sources: [], exclusions: [] };
  const service = createReviewService({
    root: fixture.root,
    store: createSqliteSessionStore(fixture.root),
    captureStaged,
    capture: captureSnapshot,
    loadTarget: async () => target,
    resolvePolicy: async () => ({
      ...policy,
      hash: createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
    }),
    agent: { review: async () => [] },
  });
  const session = await service.start();
  return { ...fixture, service, session, snapshotId: session.snapshot.id };
};

test('walkthrough marks, notes and verdicts persist and stay inside the frozen snapshot', async () => {
  const f = await setup();
  try {
    const { id } = f.session;
    const walk = f.service.interaction.walkthrough;
    let state = await walk(id, {
      action: 'review',
      revision: 0,
      snapshotId: f.snapshotId,
      path: 'example.ts',
      reviewed: true,
    });
    // Marking an already reviewed file is a no-op, not a duplicate entry or a new revision.
    state = await walk(id, {
      action: 'review',
      revision: state.revision,
      snapshotId: f.snapshotId,
      path: 'example.ts',
      reviewed: true,
    });
    expect(state.revision).toBe(1);
    expect(state.walkthrough.reviewed).toHaveLength(1);
    await expect(
      walk(id, {
        action: 'note',
        revision: state.revision,
        snapshotId: f.snapshotId,
        path: 'elsewhere.ts',
        line: 1,
        text: 'Not in the change',
      }),
    ).rejects.toThrow('not part of this snapshot');
    await expect(
      walk(id, {
        action: 'review',
        revision: 0,
        snapshotId: f.snapshotId,
        path: 'example.ts',
        reviewed: false,
      }),
    ).rejects.toThrow('revision conflict');
    state = await walk(id, {
      action: 'note',
      revision: state.revision,
      snapshotId: f.snapshotId,
      path: 'example.ts',
      line: 1,
      text: '  Use 3 here  ',
    });
    const note = state.walkthrough.notes[0];
    expect(note).toMatchObject({ side: 'new', line: 1, text: 'Use 3 here' });
    state = await walk(id, {
      action: 'verdict',
      revision: state.revision,
      snapshotId: f.snapshotId,
      decision: 'request-changes',
      handoff: 'Please change example.ts:1',
    });
    state = await walk(id, { action: 'remove-note', revision: state.revision, noteId: note?.id });
    const reopened = createSqliteSessionStore(f.root);
    const saved = await reopened.interaction(id);
    expect(saved.walkthrough.notes).toEqual([]);
    expect(saved.walkthrough.reviewed.map((entry) => entry.path)).toEqual(['example.ts']);
    expect(saved.walkthrough.verdicts[0]).toMatchObject({
      decision: 'request-changes',
      handoff: 'Please change example.ts:1',
    });
  } finally {
    await f.dispose();
  }
});
