import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCorrectnessReviewer } from '@hunkyard/agents';
import { loadTarget, resolvePolicy } from '@hunkyard/context';
import { createReviewPlan, createReviewService } from '@hunkyard/core';
import type { ReviewAgent } from '@hunkyard/core/ports';
import { ReviewOptionsSchema } from '@hunkyard/domain';
import { captureStaged } from '@hunkyard/git';
import { createSqliteSessionStore } from '@hunkyard/storage';
import { expect, test } from 'vitest';
import { createGitFixture } from './git-fixture';
import { benchmarkCases, benchmarkFinding, scriptedReviewer } from './phase-four-fixtures';

const setup = async () => {
  const fixture = await createGitFixture();
  const dir = await mkdtemp(join(tmpdir(), 'hunkyard-phase4-config-'));
  const previous = process.env.HUNKYARD_USER_CONFIG;
  process.env.HUNKYARD_USER_CONFIG = join(dir, 'config.json');
  for (const item of benchmarkCases) {
    await writeFile(join(fixture.root, item.file), `${item.bug}\n`);
    await writeFile(join(fixture.root, `safe-${item.file}`), `${item.safe}\n`);
  }
  await fixture.git('add', '.');
  const snapshot = await captureStaged(fixture.root);
  const policy = await resolvePolicy(fixture.root);
  const target = await loadTarget(fixture.root);
  const store = createSqliteSessionStore(fixture.root);
  const service = (agent: ReviewAgent, overrides = {}) =>
    createReviewService({
      root: fixture.root,
      store,
      agent,
      captureStaged: async () => snapshot,
      resolvePolicy: async () => policy,
      loadTarget: async () => ({ ...target, ...overrides }),
      loadReviewOptions: async () => ReviewOptionsSchema.parse({}),
    });
  return {
    ...fixture,
    snapshot,
    policy,
    target,
    store,
    service,
    dispose: async () => {
      if (previous === undefined) delete process.env.HUNKYARD_USER_CONFIG;
      else process.env.HUNKYARD_USER_CONFIG = previous;
      await fixture.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
};

test('profiles route frozen model targets, dedup deterministically, persist attributions and preserve old runs', async () => {
  const fixture = await setup();
  try {
    const service = fixture.service(scriptedReviewer());
    const initial = await service.start(
      {},
      { profile: 'deep', concurrency: 3, agentModels: { security: { model: 'security-fixture' } } },
    );
    await expect(
      fixture.store.save({
        ...initial,
        revision: initial.revision + 1,
        plan: createReviewPlan(fixture.target, { profile: 'standard' }),
      }),
    ).rejects.toThrow('Run input is immutable');
    await service.execute(initial.id);
    const result = await service.get(initial.id);
    expect(result?.status).toBe('completed');
    expect(result?.findings).toHaveLength(5);
    const shared = result?.findings.find((finding) => finding.file === 'nullable.ts');
    expect(shared?.attributions?.map((entry) => entry.agent)).toEqual([
      'correctness',
      'security',
      'frontend',
      'architecture',
      'testing',
    ]);
    expect(shared?.attributions?.[1]?.target.model).toBe('security-fixture');
    expect(result?.orchestration?.reportedInputTokens).toBe(500);
    expect(result?.orchestration?.reservedTokens).toBeGreaterThan(20000);
    expect(
      (await service.events(initial.id, 0)).some(
        (event) => event.data.message === 'security: completed',
      ),
    ).toBe(true);
    if (!result) throw new Error('Missing result');
    const { orchestration: _omitted, ...missingResults } = result;
    await expect(
      fixture.store.save({ ...missingResults, revision: result.revision + 1 }),
    ).rejects.toThrow('missing agent results');
    await service.rerun(
      initial.id,
      result.revision,
      false,
      ReviewOptionsSchema.parse({ profile: 'quick' }),
    );
    await service.execute(initial.id);
    const runs = await service.runs(initial.id);
    expect(runs.map((run) => run.findings.length)).toEqual([5, 1]);
    expect(runs[0]?.plan?.options.profile).toBe('deep');
    const exported = await service.export(initial.id, false);
    expect(JSON.stringify(exported)).toContain('security-fixture');
  } finally {
    await fixture.dispose();
  }
});

test('verifier removes unsupported candidates, cannot invent or change findings, and unrelated same-line defects remain separate', async () => {
  const fixture = await setup();
  try {
    const service = fixture.service(scriptedReviewer(true));
    const initial = await service.start({}, { profile: 'standard', verify: true });
    await service.execute(initial.id);
    const result = await service.get(initial.id);
    expect(result?.status).toBe('completed');
    expect(result?.findings).toHaveLength(3);
    expect(result?.findings.every((finding) => finding.verified)).toBe(true);
    expect(result?.orchestration?.agents[0]?.findings).toHaveLength(2);
    const malicious = fixture.service({
      review: async ({ agentId }) =>
        agentId === 'verifier'
          ? [{ ...benchmarkFinding(0), explanation: 'Invented replacement' }]
          : [
              benchmarkFinding(0),
              { ...benchmarkFinding(0), title: 'Another defect', recommendation: 'Another fix' },
            ],
    });
    const second = await malicious.start({}, { verify: true });
    await malicious.execute(second.id);
    expect((await malicious.get(second.id))?.error).toContain('Verifier changed or invented');
    expect((await malicious.get(second.id))?.findings).toEqual([]);
    expect((await malicious.get(second.id))?.orchestration?.agents[0]?.findings).toHaveLength(2);
  } finally {
    await fixture.dispose();
  }
});

test('malformed payloads fail visibly after bounded repair; repairs and transient retries share the run token budget', async () => {
  const fixture = await setup();
  try {
    let calls = 0;
    const broken = fixture.service(
      createCorrectnessReviewer(async () => {
        calls++;
        return {
          message: {
            content: JSON.stringify({ findings: [{ ...benchmarkFinding(0), line: 999 }] }),
          },
        };
      }),
    );
    const session = await broken.start({}, { retries: 2 });
    await broken.execute(session.id);
    expect(calls).toBe(2);
    expect((await broken.get(session.id))?.error).toContain('after one repair');
    expect((await broken.get(session.id))?.orchestration?.agents[0]?.status).toBe('failed');
    calls = 0;
    const limited = fixture.service(
      createCorrectnessReviewer(async () => {
        calls++;
        throw new Error('Model endpoint unavailable');
      }),
      { maxReviewTokens: 10000 },
    );
    const limitedSession = await limited.start({}, { retries: 2 });
    await limited.execute(limitedSession.id);
    expect(calls).toBe(1);
    const result = await limited.get(limitedSession.id);
    expect(result?.error).toContain('Shared review token budget');
    expect(result?.orchestration?.reservedTokens).toBeLessThanOrEqual(10000);
    const repaired = fixture.service(
      createCorrectnessReviewer(async () => {
        calls++;
        return { message: { content: 'bad JSON' } };
      }),
      { maxReviewTokens: 10000 },
    );
    calls = 0;
    const repairSession = await repaired.start();
    await repaired.execute(repairSession.id);
    expect(calls).toBe(1);
    expect((await repaired.get(repairSession.id))?.error).toContain('token budget exhausted');
  } finally {
    await fixture.dispose();
  }
});

test('every route enforces local-only privacy and explicit hosted pricing/caps before dispatch; unknown usage remains unknown', async () => {
  const fixture = await setup();
  try {
    let calls = 0;
    const reviewer = createCorrectnessReviewer(
      async () => {
        calls++;
        return {
          message: { content: '{"findings":[]}' },
          choices: [{ message: { content: '{"findings":[]}' } }],
        };
      },
      async () => 'synthetic-fixture-key',
    );
    const service = fixture.service(reviewer);
    await expect(
      service.start(
        {},
        {
          agentModels: { security: { provider: 'openai', endpoint: 'https://api.openai.com' } },
          profile: 'standard',
        },
      ),
    ).rejects.toThrow('Local-only');
    await expect(
      service.start({}, { agentModels: { correctness: { endpoint: 'http://example.com' } } }),
    ).rejects.toThrow('loopback');
    const hosted = fixture.service(reviewer, {
      provider: 'openai',
      endpoint: 'https://api.openai.com',
      privacy: 'cloud-allowed',
      cloudConsent: true,
      approvedHostedOrigins: ['https://api.openai.com'],
    });
    const cap = await hosted.start({}, { maxCostUsd: 0 });
    await hosted.execute(cap.id);
    expect(calls).toBe(0);
    expect((await hosted.get(cap.id))?.error).toContain('explicit input/output pricing');
    const priced = await hosted.start(
      {},
      { maxCostUsd: 0, prices: { correctness: { inputPerMillion: 1, outputPerMillion: 1 } } },
    );
    await hosted.execute(priced.id);
    expect(calls).toBe(0);
    expect((await hosted.get(priced.id))?.error).toContain('cost budget');
    const local = await service.start();
    await service.execute(local.id);
    expect((await service.get(local.id))?.orchestration?.usageComplete).toBe(false);
    expect(calls).toBe(1);
  } finally {
    await fixture.dispose();
  }
});

test('queued reviews obey priority, cancel without dispatch, and late completion cannot overwrite cancellation', async () => {
  const fixture = await setup();
  try {
    const order: string[] = [];
    let finish: (() => void) | undefined;
    const service = fixture.service({
      review: async ({ target }) => {
        order.push(target.model);
        if (target.model === 'held')
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        return [benchmarkFinding(0)];
      },
    });
    const held = await service.start({}, { agentModels: { correctness: { model: 'held' } } });
    const first = service.execute(held.id);
    await expect.poll(() => Boolean(finish)).toBe(true);
    const background = await service.start(
      {},
      { priority: 'background', agentModels: { correctness: { model: 'background' } } },
    );
    const backgroundRun = service.execute(background.id);
    const cancelled = await service.start(
      {},
      { agentModels: { correctness: { model: 'cancelled' } } },
    );
    const cancelledRun = service.execute(cancelled.id);
    const interactive = await service.start(
      {},
      { agentModels: { correctness: { model: 'interactive' } } },
    );
    const interactiveRun = service.execute(interactive.id);
    await expect.poll(async () => (await service.get(interactive.id))?.status).toBe('queued');
    await service.cancel(cancelled.id);
    await service.cancel(held.id);
    finish?.();
    await Promise.all([first, backgroundRun, cancelledRun, interactiveRun]);
    expect(order).toEqual(['held', 'interactive', 'background']);
    expect((await service.get(held.id))?.status).toBe('cancelled');
    expect((await service.get(held.id))?.findings).toEqual([]);
    expect((await service.get(cancelled.id))?.status).toBe('cancelled');
  } finally {
    await fixture.dispose();
  }
});

test('bounded specialist concurrency, timeout and source-budget failures cannot create a successful partial review', async () => {
  const fixture = await setup();
  try {
    let active = 0;
    let peak = 0;
    let arrivals = 0;
    let release: (() => void) | undefined;
    const overlap = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = fixture.service({
      review: async () => {
        active++;
        peak = Math.max(active, peak);
        arrivals++;
        if (arrivals <= 2) {
          if (arrivals === 2) release?.();
          await overlap;
        }
        active--;
        return [];
      },
    });
    const initial = await service.start({}, { profile: 'deep', concurrency: 2 });
    await service.execute(initial.id);
    expect(peak).toBe(2);
    const timed = fixture.service(
      {
        review: async ({ signal }) =>
          new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('Timed out')), { once: true }),
          ),
      },
      { timeoutMs: 100 },
    );
    const timeout = await timed.start();
    await timed.execute(timeout.id);
    expect((await timed.get(timeout.id))?.status).toBe('failed');
    const session = await service.get(initial.id);
    if (!session) throw new Error('Missing result');
    const budgeted = createReviewService({
      root: fixture.root,
      store: fixture.store,
      loadTarget: async () => fixture.target,
      loadReviewOptions: async () => ReviewOptionsSchema.parse({}),
      captureStaged: async () => fixture.snapshot,
      resolvePolicy: async () => fixture.policy,
      buildContext: async () => ({
        id: crypto.randomUUID(),
        snapshotId: fixture.snapshot.id,
        policyHash: fixture.policy.hash,
        promptVersion: 'correctness-v1',
        files: [],
        excludedFiles: [],
        redacted: true,
        maxInputTokens: 1000,
        createdAt: new Date().toISOString(),
        entries: [],
      }),
      agent: { review: async () => [benchmarkFinding(0)] },
    });
    const omission = await budgeted.start();
    await budgeted.execute(omission.id);
    expect((await budgeted.get(omission.id))?.error).toContain('omitted');
    expect((await budgeted.get(omission.id))?.findings).toEqual([]);
    expect(await readFile(join(fixture.root, 'nullable.ts'), 'utf8')).toBe(
      `${benchmarkCases[0]?.bug}\n`,
    );
  } finally {
    await fixture.dispose();
  }
});

test('seeded benchmark compares profiles/models and safe counterexamples without claiming inference quality', async () => {
  const { runQualityBenchmark } = await import('./phase-four-benchmark');
  const report = await runQualityBenchmark();
  expect(report.synthetic).toBe(true);
  expect(report.rows).toHaveLength(12);
  expect(report.rows.every((row) => row.status === 'completed')).toBe(true);
  expect(
    report.rows.find(
      (row) => row.model === 'scripted-precise' && row.profile === 'deep' && !row.verify,
    ),
  ).toMatchObject({ truePositives: 5, falsePositives: 0, rawCandidates: 9, finalFindings: 5 });
  expect(
    report.rows.find(
      (row) => row.model === 'scripted-noisy' && row.profile === 'standard' && !row.verify,
    ),
  ).toMatchObject({ truePositives: 3, falsePositives: 1, rawCandidates: 8, finalFindings: 4 });
  expect(
    report.rows.find(
      (row) => row.model === 'scripted-noisy' && row.profile === 'deep' && row.verify,
    ),
  ).toMatchObject({ truePositives: 5, falsePositives: 0, finalFindings: 5 });
});

test('transient retry is bounded, repeat execution does not dispatch twice, and queued hosted routes recheck revoked consent', async () => {
  const fixture = await setup();
  try {
    let calls = 0;
    const retried = fixture.service(
      createCorrectnessReviewer(async () => {
        calls++;
        if (calls === 1) throw new Error('Model endpoint returned HTTP 503.');
        return {
          message: { content: JSON.stringify({ findings: [benchmarkFinding(0)] }) },
          prompt_eval_count: 10,
          eval_count: 10,
        };
      }),
    );
    const first = await retried.start({}, { retries: 1 });
    await Promise.all([retried.execute(first.id), retried.execute(first.id)]);
    expect(calls).toBe(2);
    const result = await retried.get(first.id);
    expect(result?.status).toBe('completed');
    expect(result?.orchestration?.agents[0]?.attempts).toBe(2);
    expect(result?.orchestration?.usageComplete).toBe(false);
    expect(result?.orchestration?.reservedTokens).toBeGreaterThan(10000);
    let consent = true;
    const target = {
      ...fixture.target,
      privacy: 'cloud-allowed' as const,
      cloudConsent: true,
      approvedHostedOrigins: ['https://api.openai.com'],
    };
    const service = createReviewService({
      root: fixture.root,
      store: fixture.store,
      captureStaged: async () => fixture.snapshot,
      resolvePolicy: async () => fixture.policy,
      loadTarget: async () => ({ ...target, cloudConsent: consent }),
      loadReviewOptions: async () => ReviewOptionsSchema.parse({}),
      agent: {
        review: async () => {
          calls++;
          return [];
        },
      },
    });
    const queued = await service.start(
      {},
      {
        profile: 'standard',
        agentModels: { security: { provider: 'openai', endpoint: 'https://api.openai.com' } },
      },
    );
    consent = false;
    const before = calls;
    await service.execute(queued.id);
    expect(calls).toBe(before + 2);
    const denied = await service.get(queued.id);
    expect(denied?.status).toBe('failed');
    expect(denied?.error).toContain('revoked');
    expect(denied?.orchestration?.agents.find((entry) => entry.id === 'security')?.attempts).toBe(
      1,
    );
    expect(denied?.findings).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});
