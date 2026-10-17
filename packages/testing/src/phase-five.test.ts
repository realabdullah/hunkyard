import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConversationResponder } from '@hunkyard/agents';
import { createReviewService } from '@hunkyard/core';
import { type Interaction, type ModelTarget } from '@hunkyard/domain';
import { captureSnapshot, captureStaged, createPatchAdapter } from '@hunkyard/git';
import { withSessionRules } from '@hunkyard/server/context';
import { createSqliteSessionStore } from '@hunkyard/storage';
import { expect, test, vi } from 'vitest';
import { createGitFixture } from './git-fixture';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const setup = async (twoFindings = false) => {
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
  const store = createSqliteSessionStore(fixture.root);
  let reportFindings = true;
  const service = createReviewService({
    root: fixture.root,
    store,
    captureStaged,
    capture: captureSnapshot,
    loadTarget: async () => target,
    resolvePolicy: async () => ({
      version: 1,
      hash: createHash('sha256')
        .update(JSON.stringify({ version: 1, instructions: [], sources: [], exclusions: [] }))
        .digest('hex'),
      instructions: [],
      sources: [],
      exclusions: [],
    }),
    agent: {
      review: async () =>
        reportFindings
          ? [
              {
                file: 'example.ts',
                line: 1,
                side: 'new',
                severity: 'high',
                title: 'Seeded issue',
                explanation: 'A fixture issue',
                evidence: 'export const value = 2;',
                recommendation: 'Use 3',
              },
              ...(twoFindings
                ? [
                    {
                      file: 'example.ts',
                      line: 1,
                      side: 'new' as const,
                      severity: 'low' as const,
                      title: 'Second preference',
                      explanation: 'Another fixture issue',
                      evidence: 'export const value = 2;',
                      recommendation: 'Use 3',
                    },
                  ]
                : []),
            ]
          : [],
    },
    applySessionRules: withSessionRules,
    patch: createPatchAdapter(fixture.root),
    respond: async () => ({ text: 'Suggested answer, no verified tests.', target }),
  });
  const initial = await service.start();
  await service.execute(initial.id);
  const session = await service.get(initial.id);
  if (!session || !session.findings[0]) throw new Error('Missing review');
  return {
    ...fixture,
    service,
    store,
    session,
    finding: session.findings[0],
    target,
    omitFindings: () => {
      reportFindings = false;
    },
  };
};
test('thread, citation, reaction and status history survive reopen and retain frozen evidence', async () => {
  const f = await setup();
  try {
    const runId = f.session.runId ?? f.session.id;
    let state = await f.service.interaction.message(f.session.id, {
      revision: 0,
      runId,
      findingId: f.finding.id,
      text: 'Why?',
      kind: 'question',
      citations: [{ runId, snapshotId: f.session.snapshot.id, findingId: f.finding.id }],
    });
    expect(state.messages.map((entry) => entry.actor)).toEqual(['user', 'assistant']);
    const answer = state.messages[1];
    if (!answer) throw new Error('Missing answer');
    state = await f.service.interaction.react(f.session.id, answer.id, {
      revision: state.revision,
      reaction: 'helpful',
    });
    await expect(
      f.service.interaction.transition(f.session.id, f.finding.id, {
        revision: 0,
        runId,
        status: 'fixed',
      }),
    ).rejects.toThrow('revision conflict');
    await expect(
      f.service.interaction.transition(f.session.id, f.finding.id, {
        revision: state.revision,
        runId,
        status: 'dismissed',
      }),
    ).rejects.toThrow('reason');
    state = await f.service.interaction.transition(f.session.id, f.finding.id, {
      revision: state.revision,
      runId,
      status: 'fixed',
      note: 'User asserted fix',
    });
    await expect(
      f.service.interaction.message(f.session.id, {
        revision: state.revision,
        runId,
        text: 'wrong parent',
        parentId: answer.id,
      }),
    ).rejects.toThrow('same thread');
    expect(await createSqliteSessionStore(f.root).interaction(f.session.id)).toEqual(state);
    expect((await f.store.runs(f.session.id))[0]?.findings[0]).toEqual(f.finding);
    await f.service.rerun(f.session.id, f.session.revision);
    await f.service.execute(f.session.id);
    const reconciled = await f.service.interaction.read(f.session.id);
    expect(reconciled.comparisons[0]?.outcome).toBe('reintroduced');
    expect(reconciled.transitions.at(-1)?.to).toBe('reintroduced');
    expect(reconciled.messages).toEqual(state.messages);
    await expect(
      f.service.interaction.message(f.session.id, {
        revision: reconciled.revision,
        runId,
        text: 'bad citation',
        citations: [{ runId, snapshotId: crypto.randomUUID(), findingId: f.finding.id }],
      }),
    ).rejects.toThrow('retained evidence');
  } finally {
    await f.dispose();
  }
});
const propose = async (f: Awaited<ReturnType<typeof setup>>) => {
  const state = await f.service.interaction.propose(f.session.id, {
    revision: (await f.service.interaction.read(f.session.id)).revision,
    runId: f.session.runId,
    file: 'example.ts',
    replacement: 'export const value = 3;\n',
  });
  const patch = state.patches.at(-1);
  if (!patch) throw new Error('Missing patch');
  return { state, patch };
};
const approve = async (
  f: Awaited<ReturnType<typeof setup>>,
  state: Interaction,
  patchId: string,
  isolated = false,
) => {
  const approved = await f.service.interaction.approve(f.session.id, patchId, {
    revision: state.revision,
    approved: true,
    isolated,
  });
  return { revision: approved.revision, approvalToken: approved.patches.at(-1)?.approvalToken };
};
test('patch requires approval, applies exact bytes, preserves index/backup and refuses newer edits or replay', async () => {
  const f = await setup();
  try {
    const { state, patch } = await propose(f);
    const index = await f.git('write-tree');
    expect(patch.preview).toContain('-export const value = 2;');
    await expect(
      f.service.interaction.apply(f.session.id, patch.id, {
        revision: state.revision,
        approvalToken: crypto.randomUUID(),
      }),
    ).rejects.toThrow('explicit approval');
    const approved = await approve(f, state, patch.id);
    await writeFile(join(f.root, 'example.ts'), 'newer unstaged edits\n');
    const conflict = await f.service.interaction.apply(f.session.id, patch.id, approved);
    expect(conflict.patches[0]?.status).toBe('conflict');
    expect(await readFile(join(f.root, 'example.ts'), 'utf8')).toBe('newer unstaged edits\n');
    await writeFile(join(f.root, 'example.ts'), 'export const value = 2;\n');
    const next = await propose(f);
    const nextApproval = await approve(f, next.state, next.patch.id);
    const applied = await f.service.interaction.apply(f.session.id, next.patch.id, nextApproval);
    expect(applied.patches[1]?.status).toBe('applied');
    expect(await readFile(join(f.root, 'example.ts'), 'utf8')).toBe('export const value = 3;\n');
    expect(await readFile(applied.patches[1]?.backup ?? '', 'utf8')).toBe(
      'export const value = 2;\n',
    );
    expect(await f.git('write-tree')).toBe(index);
    await expect(
      f.service.interaction.apply(f.session.id, next.patch.id, {
        ...nextApproval,
        revision: applied.revision,
      }),
    ).rejects.toThrow('unused explicit approval');
    expect((await f.store.runs(f.session.id))[0]?.snapshot).toEqual(f.session.snapshot);
  } finally {
    await f.dispose();
  }
});
test('patch rejects traversal and symlinks; isolated experiment preserves developer edits', async () => {
  const f = await setup();
  try {
    await expect(
      f.service.interaction.propose(f.session.id, {
        revision: 0,
        runId: f.session.runId,
        file: '../example.ts',
        replacement: 'bad',
      }),
    ).rejects.toThrow();
    const first = await propose(f);
    await unlink(join(f.root, 'example.ts'));
    await symlink('outside.ts', join(f.root, 'example.ts'));
    const failed = await f.service.interaction.apply(
      f.session.id,
      first.patch.id,
      await approve(f, first.state, first.patch.id),
    );
    expect(failed.patches[0]?.error).toContain('symlinks');
    await unlink(join(f.root, 'example.ts'));
    await writeFile(join(f.root, 'example.ts'), 'developer changes');
    const next = await propose(f);
    const result = await f.service.interaction.apply(
      f.session.id,
      next.patch.id,
      await approve(f, next.state, next.patch.id, true),
    );
    expect(result.patches[1]?.status).toBe('applied');
    expect(await readFile(join(f.root, 'example.ts'), 'utf8')).toBe('developer changes');
    expect(await readFile(join(result.patches[1]?.destination ?? '', 'example.ts'), 'utf8')).toBe(
      'export const value = 3;\n',
    );
  } finally {
    await f.dispose();
  }
});
test('conversation gateway enforces local-only egress and redacts prompts without fallback', async () => {
  const f = await setup();
  try {
    let requests = 0;
    const responder = createConversationResponder(
      async () => ({ ...f.target, provider: 'openai', endpoint: 'https://api.openai.com' }),
      undefined,
      async () => {
        requests++;
        return {};
      },
    );
    const state = await f.service.interaction.message(f.session.id, {
      revision: 0,
      runId: f.session.runId,
      text: 'note',
    });
    const message = state.messages[0];
    if (!message) throw new Error('Missing message');
    await expect(
      responder({ session: f.session, state, message, signal: new AbortController().signal }),
    ).rejects.toThrow('Local-only');
    expect(requests).toBe(0);
  } finally {
    await f.dispose();
  }
});

test('streamed answers reach the caller live, keep the 8000-char contract and never leave local-only', async () => {
  const f = await setup();
  try {
    const state = await f.service.interaction.message(f.session.id, {
      revision: 0,
      runId: f.session.runId,
      text: 'note',
    });
    const message = state.messages[0];
    if (!message) throw new Error('Missing message');
    const signal = new AbortController().signal;
    const ndjson = (...parts: string[]) =>
      async function* () {
        yield* parts.map((content, index) =>
          index === parts.length - 1
            ? `{"message":{"content":${JSON.stringify(content)}},"done":true,"done_reason":"stop"}\n`
            : `{"message":{"content":${JSON.stringify(content)}},"done":false}\n`,
        );
      };
    const seen: string[] = [];
    const answer = await createConversationResponder(
      async () => f.target,
      undefined,
      undefined,
      ndjson('Use ', 'timingSafeEqual', '.'),
    )({ session: f.session, state, message, signal, onDelta: (text) => seen.push(text) });
    expect(seen).toEqual(['Use ', 'timingSafeEqual', '.']);
    expect(answer.text).toBe('Use timingSafeEqual.');
    await expect(
      createConversationResponder(
        async () => f.target,
        undefined,
        undefined,
        ndjson('x'.repeat(8001), ''),
      )({ session: f.session, state, message, signal, onDelta: () => {} }),
    ).rejects.toThrow('truncated');
    let streams = 0;
    await expect(
      createConversationResponder(
        async () => ({ ...f.target, provider: 'openai', endpoint: 'https://api.openai.com' }),
        undefined,
        undefined,
        async function* () {
          streams++;
          yield '';
        },
      )({ session: f.session, state, message, signal, onDelta: () => {} }),
    ).rejects.toThrow('Local-only');
    expect(streams).toBe(0);
  } finally {
    await f.dispose();
  }
});

test('an editor recreating the destination during publication wins; both byte streams are retained', async () => {
  const f = await setup();
  const renameMock = vi.mocked(fs.rename);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  try {
    const { state, patch } = await propose(f);
    const approval = await approve(f, state, patch.id);
    renameMock.mockImplementationOnce(async (from, to) => {
      await actual.rename(from, to);
      await writeFile(join(f.root, 'example.ts'), 'editor-created replacement\n');
    });
    const result = await f.service.interaction.apply(f.session.id, patch.id, approval);
    expect(result.patches[0]?.status).toBe('conflict');
    expect(await readFile(join(f.root, 'example.ts'), 'utf8')).toBe('editor-created replacement\n');
    expect(await readFile(join(f.root, `example.ts.hunkyard-${patch.id}.bak`), 'utf8')).toBe(
      'export const value = 2;\n',
    );
  } finally {
    renameMock.mockImplementation(actual.rename);
    await f.dispose();
  }
});

test('rule consent changes only future frozen inputs and targeted recapture never marks omitted defects fixed', async () => {
  const f = await setup(true);
  try {
    const runId = f.session.runId ?? f.session.id;
    expect(f.session.findings).toHaveLength(2);
    let state = await f.service.interaction.read(f.session.id);
    for (const finding of f.session.findings)
      state = await f.service.interaction.transition(f.session.id, finding.id, {
        revision: state.revision,
        runId,
        status: 'dismissed',
        reason: 'preference',
      });
    state = await f.service.interaction.suggestRule(f.session.id, state.revision);
    expect(state.rules[0]?.status).toBe('suggested');
    const ruleId = state.rules[0]?.id;
    if (!ruleId) throw new Error('Missing rule');
    await expect(
      f.service.interaction.decideRule(f.session.id, ruleId, {
        revision: state.revision,
        decision: 'accepted',
        consent: false,
      }),
    ).rejects.toThrow();
    await f.service.interaction.decideRule(f.session.id, ruleId, {
      revision: state.revision,
      decision: 'accepted',
      consent: true,
    });
    const rerun = await f.service.rerun(f.session.id, f.session.revision, true, undefined, [
      'example.ts',
    ]);
    expect(rerun?.snapshot.capture?.paths).toEqual(['example.ts']);
    expect(rerun?.instructions.join('\n')).toContain('User-approved session rules');
    await f.service.execute(f.session.id);
    expect((await f.store.runs(f.session.id))[0]?.policy).toEqual(f.session.policy);
    expect(
      (await f.service.interaction.read(f.session.id)).comparisons.every(
        (entry) => entry.outcome === 'matched',
      ),
    ).toBe(true);
    f.omitFindings();
    const latest = await f.service.get(f.session.id);
    if (!latest) throw new Error('Missing latest run');
    await f.service.rerun(f.session.id, latest.revision, true, undefined, ['example.ts']);
    await f.service.execute(f.session.id);
    const afterOmission = await f.service.interaction.read(f.session.id);
    expect(afterOmission.comparisons.slice(-2).map((entry) => entry.outcome)).toEqual([
      'stale',
      'stale',
    ]);
    expect(
      afterOmission.transitions.some((entry) => entry.actor === 'system' && entry.to === 'fixed'),
    ).toBe(false);
    await expect(
      f.service.interaction.propose(f.session.id, {
        revision: (await f.service.interaction.read(f.session.id)).revision,
        runId,
        file: '.hunkyard/config.json',
        replacement: '{}',
      }),
    ).rejects.toThrow();
  } finally {
    await f.dispose();
  }
});

test('model drafting persists provenance and proposes without approval or source writes', async () => {
  const f = await setup();
  try {
    const before = await readFile(join(f.root, 'example.ts'), 'utf8');
    const state = await f.service.interaction.draftPatch(f.session.id, {
      revision: 0,
      runId: f.session.runId,
      file: 'example.ts',
      model: 'chosen-model',
    });
    expect(state.messages.at(-1)?.actor).toBe('assistant');
    expect(state.messages.at(-1)?.snapshotId).toBe(f.session.snapshot.id);
    expect(state.patches[0]?.status).toBe('proposed');
    expect(state.patches[0]?.approvalToken).toBeUndefined();
    expect(await readFile(join(f.root, 'example.ts'), 'utf8')).toBe(before);
  } finally {
    await f.dispose();
  }
});
