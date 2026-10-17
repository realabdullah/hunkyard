import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalEmbedder } from '@reviewlab/agents';
import { collectContext, loadTarget, resolvePolicy, withSharedPolicy } from '@reviewlab/context';
import {
  createReviewPlan,
  createReviewService,
  effectivenessAnalytics,
  recommendPresets,
} from '@reviewlab/core';
import {
  emptyInteraction,
  ModelTargetSchema,
  ReviewOptionsSchema,
  ShareablePolicySchema,
  WorkflowSchema,
} from '@reviewlab/domain';
import { captureStaged, runBytes, treeEntries } from '@reviewlab/git';
import { createRuntime } from '@reviewlab/server/runtime';
import { createSqliteSessionStore } from '@reviewlab/storage';
import {
  assertExtensionAccess,
  assertExternalExecutable,
  frozenFindingSource,
  resolveExecutable,
  runCli,
  trustedExecutable,
} from 'reviewlab-vscode/bridge';
import { expect, test } from 'vitest';
import { createGitFixture } from './git-fixture';
import { benchmarkCases, benchmarkFinding } from './phase-four-fixtures';

const target = ModelTargetSchema.parse({ repository: 'fixture', cloudConsent: false });
const policy = {
  version: 1 as const,
  instructions: [],
  sources: [],
  exclusions: [],
  hash: createHash('sha256')
    .update(JSON.stringify({ version: 1, instructions: [], sources: [], exclusions: [] }))
    .digest('hex'),
};
const graph = {
  version: 1,
  nodes: [
    { agent: 'security', after: ['correctness'] },
    { agent: 'correctness', after: [] },
    { agent: 'verifier', after: ['correctness', 'security'] },
  ],
};

test('workflow validates dependencies and preserves ordered, budgeted, immutable execution across reopen', async () => {
  for (const nodes of [
    [{ agent: 'correctness', after: ['security'] }],
    [{ agent: 'correctness', after: ['correctness'] }],
    [{ agent: 'correctness' }, { agent: 'correctness' }],
    [
      { agent: 'correctness', after: ['security'] },
      { agent: 'security', after: ['correctness'] },
    ],
    [{ agent: 'correctness' }, { agent: 'verifier' }],
  ])
    expect(() => WorkflowSchema.parse({ version: 1, nodes })).toThrow();
  expect(() => createReviewPlan(target, { workflow: graph })).toThrow(/verify/);
  expect(() =>
    createReviewPlan(target, {
      workflow: graph,
      verify: true,
      agentModels: { security: { provider: 'openai', endpoint: 'https://api.openai.com' } },
    }),
  ).toThrow(/Local-only/);
  const fixture = await createGitFixture();
  try {
    await writeFile(join(fixture.root, 'nullable.ts'), `${benchmarkCases[0]?.bug}\n`);
    await fixture.git('add', '.');
    const snapshot = await captureStaged(fixture.root);
    const store = createSqliteSessionStore(fixture.root);
    const calls: string[] = [];
    const service = createReviewService({
      root: fixture.root,
      store,
      captureStaged: async () => snapshot,
      resolvePolicy: async () => policy,
      loadTarget: async () => target,
      loadReviewOptions: async () => ReviewOptionsSchema.parse({}),
      agent: {
        review: async (input) => {
          calls.push(input.agentId ?? '');
          input.reserve?.(10, 10);
          input.onUsage?.(10, 10);
          return input.candidates ?? [benchmarkFinding(0)];
        },
      },
    });
    const session = await service.start(
      {},
      { workflow: graph, verify: true, concurrency: 3, tokenBudget: 512 },
    );
    await service.execute(session.id);
    const reopened = await createSqliteSessionStore(fixture.root).get(session.id);
    expect(reopened?.status).toBe('completed');
    expect(calls).toEqual(['correctness', 'security', 'verifier']);
    expect(reopened?.plan?.options.workflow).toEqual(graph);
    expect(reopened?.orchestration?.reservedTokens).toBe(60);
    expect(reopened?.findings).toHaveLength(1);
    if (!reopened) throw new Error('Missing result');
    expect(frozenFindingSource(reopened, reopened.findings[0]?.id ?? '').text).toContain(
      benchmarkCases[0]?.bug,
    );
    await service.rerun(session.id, reopened.revision, false);
    await service.execute(session.id);
    expect(await store.runs(session.id)).toHaveLength(2);
    expect(calls).toEqual([
      'correctness',
      'security',
      'verifier',
      'correctness',
      'security',
      'verifier',
    ]);
    await service.shutdown();
  } finally {
    await fixture.dispose();
  }
});

test('a failed workflow prerequisite cancels dependents without invoking them', async () => {
  const fixture = await createGitFixture();
  try {
    await writeFile(join(fixture.root, 'example.ts'), 'export const value = 2;\n');
    await fixture.git('add', '.');
    const snapshot = await captureStaged(fixture.root);
    const calls: string[] = [];
    const service = createReviewService({
      root: fixture.root,
      store: createSqliteSessionStore(fixture.root),
      captureStaged: async () => snapshot,
      resolvePolicy: async () => policy,
      loadTarget: async () => target,
      loadReviewOptions: async () => ReviewOptionsSchema.parse({}),
      agent: {
        review: async (input) => {
          calls.push(input.agentId ?? '');
          throw new Error('Invalid payload');
        },
      },
    });
    const session = await service.start({}, { workflow: graph, verify: true });
    await service.execute(session.id);
    const result = await service.get(session.id);
    expect(result?.status).toBe('failed');
    expect(calls).toEqual(['correctness']);
    expect(
      result?.orchestration?.agents
        .filter((entry) => entry.id !== 'correctness')
        .every((entry) => entry.status === 'cancelled'),
    ).toBe(true);
    await service.shutdown();
  } finally {
    await fixture.dispose();
  }
});

test('shared policies cannot supply privacy or endpoints; explicit grant freezes rules/exclusions without changing defaults', async () => {
  const shared = ShareablePolicySchema.parse({
    version: 1,
    name: 'Team review',
    rules: ['Check cancellation.'],
    exclude: ['private/**'],
    review: { profile: 'standard' },
  });
  for (const extension of [
    { privacy: 'cloud-allowed' },
    { endpoint: 'https://evil.test' },
    { agentModels: { correctness: { provider: 'openai' } } },
  ])
    expect(() =>
      ShareablePolicySchema.parse({ ...shared, review: { ...shared.review, ...extension } }),
    ).toThrow();
  expect(() =>
    withSharedPolicy(policy, {
      ...shared,
      rules: Array.from({ length: 13 }, () => 'x'.repeat(4000)),
    }),
  ).toThrow(/48 KB/);
  const enriched = withSharedPolicy(policy, shared);
  expect(policy.instructions).toEqual([]);
  expect(enriched.hash).not.toBe(policy.hash);
  const fixture = await createGitFixture();
  const directory = await mkdtemp(join(tmpdir(), 'reviewlab-power-config-'));
  const old = process.env.REVIEWLAB_USER_CONFIG;
  process.env.REVIEWLAB_USER_CONFIG = join(directory, 'config.json');
  try {
    await expect(
      createRuntime(fixture.root, { sharedPolicy: { policy: shared, granted: false } }),
    ).rejects.toThrow(/permission/);
    await writeFile(join(fixture.root, 'example.ts'), 'export const value = 2;\n');
    await fixture.git('add', '.');
    const runtime = await createRuntime(fixture.root, {
      sharedPolicy: { policy: shared, granted: true },
    });
    const session = await runtime.service.start({});
    expect(session.plan?.options.profile).toBe('standard');
    expect(
      session.policy.sources.find((source) => source.format === 'shareable-policy-v1')?.content,
    ).toBe(JSON.stringify(shared));
    await runtime.close();
    const reopened = await createRuntime(fixture.root);
    expect((await reopened.service.plan()).options.profile).toBe('quick');
    expect((await reopened.service.get(session.id))?.policy.exclusions).toContain('private/**');
    await reopened.close();
  } finally {
    if (old === undefined) delete process.env.REVIEWLAB_USER_CONFIG;
    else process.env.REVIEWLAB_USER_CONFIG = old;
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('local embedding gateway blocks remote/redirected egress and malformed vectors, with no fallback', async () => {
  let calls = 0;
  for (const endpoint of [
    'https://evil.test',
    'http://localhost:11434',
    'http://127.0.0.1:11434?redirect=1',
  ])
    expect(() =>
      createLocalEmbedder({ model: 'fixture', provider: 'ollama', endpoint, granted: true }),
    ).toThrow();
  expect(() =>
    createLocalEmbedder({
      model: 'fixture:cloud',
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      granted: true,
    }),
  ).toThrow();
  expect(() =>
    createLocalEmbedder({
      model: 'fixture',
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      granted: false,
    }),
  ).toThrow();
  for (const embeddings of [[], [[0, 0]], [[1, 2], [1]], [[Number.NaN, 1]]]) {
    const embedder = createLocalEmbedder(
      { model: 'fixture', endpoint: 'http://127.0.0.1:11434', provider: 'ollama', granted: true },
      async () => {
        calls++;
        return { embeddings };
      },
    );
    await expect(
      embedder.embed(embeddings.length === 2 ? ['first', 'second'] : ['input']),
    ).rejects.toThrow();
  }
  expect(calls).toBe(4);
  const compatible = createLocalEmbedder(
    {
      model: 'fixture',
      provider: 'compatible',
      endpoint: 'http://127.0.0.1:1234/v1',
      granted: true,
    },
    async (url) => {
      expect(url.pathname).toBe('/v1/embeddings');
      return { data: [{ index: 0, embedding: [3, 4] }] };
    },
  );
  await expect(compatible.embed(['input'])).resolves.toEqual([[0.6, 0.8]]);
  const reordered = createLocalEmbedder(
    {
      model: 'fixture',
      provider: 'compatible',
      endpoint: 'http://127.0.0.1:1234/v1',
      granted: true,
    },
    async () => ({ data: [{ index: 1, embedding: [1, 0] }] }),
  );
  await expect(reordered.embed(['input'])).rejects.toThrow(/ordering/);
  const server = createServer((_req, response) => {
    response.writeHead(302, { location: 'https://evil.test' });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback address');
    const embedder = createLocalEmbedder({
      model: 'fixture',
      provider: 'ollama',
      endpoint: `http://127.0.0.1:${address.port}`,
      granted: true,
    });
    await expect(embedder.embed(['input'])).rejects.toThrow(/302/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('semantic retrieval uses frozen, excluded-filtered and redacted sources with bounded excerpts; disabled means zero requests', async () => {
  const fixture = await createGitFixture();
  const directory = await mkdtemp(join(tmpdir(), 'reviewlab-semantic-'));
  const old = process.env.REVIEWLAB_USER_CONFIG;
  process.env.REVIEWLAB_USER_CONFIG = join(directory, 'config.json');
  try {
    await writeFile(join(fixture.root, 'related.ts'), 'export const rotate = () => "expiry";\n');
    await writeFile(join(fixture.root, 'private.ts'), 'export const privateValue = 1;\n');
    await fixture.git('add', '.');
    await fixture.git('commit', '-m', 'test: semantic baseline');
    await writeFile(join(fixture.root, 'example.ts'), 'export const sessionLifetime = 30;\n');
    await fixture.git('add', 'example.ts');
    const snapshot = await captureStaged(fixture.root);
    const effective = await resolvePolicy(fixture.root);
    effective.exclusions = ['private.ts'];
    const reader = {
      entries: await treeEntries(fixture.root, snapshot.indexTree),
      read: async (oid: string) =>
        (await runBytes(fixture.root, ['cat-file', 'blob', oid])).toString(),
    };
    let calls = 0;
    const semantic = {
      provenance: {
        version: 1 as const,
        provider: 'ollama' as const,
        model: 'fixture',
        endpoint: 'http://127.0.0.1:11434',
      },
      embed: async (texts: string[]) => {
        calls++;
        expect(texts.join('\n')).not.toContain('privateValue');
        expect(texts.every((text) => Buffer.byteLength(text) <= 12000)).toBe(true);
        return texts.map(() => [1, 0]);
      },
    };
    await collectContext(snapshot, effective, target, reader);
    expect(calls).toBe(0);
    await writeFile(join(fixture.root, 'related.ts'), 'MUTATED WORKTREE');
    const context = await collectContext(snapshot, effective, target, reader, 24000, semantic);
    expect(calls).toBeGreaterThan(0);
    expect(context.entries?.find((entry) => entry.path === 'related.ts')).toMatchObject({
      reason: 'semantic',
      text: 'export const rotate = () => "expiry";\n',
    });
    expect(context.entries?.some((entry) => entry.path === 'private.ts')).toBe(false);
    expect(context.semantic?.candidates).toBe(1);
  } finally {
    if (old === undefined) delete process.env.REVIEWLAB_USER_CONFIG;
    else process.env.REVIEWLAB_USER_CONFIG = old;
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('effectiveness analytics separate unjudged, preference and false-positive outcomes; synthetic recommendations abstain', async () => {
  const fixture = await createGitFixture();
  try {
    await writeFile(join(fixture.root, 'nullable.ts'), `${benchmarkCases[0]?.bug}\n`);
    await fixture.git('add', '.');
    const snapshot = await captureStaged(fixture.root);
    const service = createReviewService({
      root: fixture.root,
      store: createSqliteSessionStore(fixture.root),
      captureStaged: async () => snapshot,
      resolvePolicy: async () => policy,
      loadTarget: async () => target,
      agent: { review: async () => [benchmarkFinding(0)] },
    });
    const session = await service.start({});
    await service.execute(session.id);
    const run = await service.get(session.id);
    if (!run) throw new Error('Missing run');
    const interaction = emptyInteraction(run.id);
    expect(effectivenessAnalytics([{ runs: [run], interaction }]).groups[0]?.unjudged).toBe(1);
    const finding = run.findings[0];
    if (!finding) throw new Error('Missing finding');
    interaction.transitions.push({
      id: randomUUID(),
      runId: run.runId ?? run.id,
      snapshotId: snapshot.id,
      findingId: finding.id,
      from: 'open',
      to: 'dismissed',
      actor: 'user',
      reason: 'false-positive',
      note: 'PRIVATE NOTE',
      createdAt: new Date().toISOString(),
    });
    const report = effectivenessAnalytics([{ runs: [run], interaction }]);
    expect(report.groups[0]?.falsePositive).toBe(1);
    expect(JSON.stringify(report)).not.toContain('PRIVATE NOTE');
    interaction.transitions.push({
      ...interaction.transitions[0]!,
      id: randomUUID(),
      reason: 'preference',
    });
    expect(effectivenessAnalytics([{ runs: [run], interaction }]).groups[0]).toMatchObject({
      falsePositive: 0,
      otherDismissed: 1,
    });
    const row = {
      model: 'fixture',
      profile: 'quick' as const,
      verify: false,
      status: 'completed',
      truePositives: 1,
      falsePositives: 0,
      recall: 0.2,
      precision: 1,
      rawCandidates: 1,
      finalFindings: 1,
      reservedTokens: 100,
    };
    expect(recommendPresets({ synthetic: true, rows: [row] }).recommendation).toBeNull();
    expect(
      recommendPresets({
        synthetic: false,
        rows: [
          { ...row, status: 'failed' },
          { ...row, model: 'successful' },
        ],
      }).recommendation?.model,
    ).toBe('successful');
    await service.shutdown();
  } finally {
    await fixture.dispose();
  }
});

test('extension refuses untrusted/virtual workspaces and executables inside the workspace, including symlinks', async () => {
  expect(() => assertExtensionAccess(false, 'file')).toThrow(/trusted/);
  expect(() => assertExtensionAccess(true, 'vscode-vfs')).toThrow();
  expect(() => trustedExecutable('./bin/reviewlab')).toThrow(/absolute/);
  const fixture = await createGitFixture();
  const directory = await mkdtemp(join(tmpdir(), 'reviewlab-vscode-'));
  try {
    expect(() =>
      assertExternalExecutable(fixture.root, join(fixture.root, '..tools', 'reviewlab')),
    ).toThrow(/outside/);
    const previousConfig = process.env.REVIEWLAB_USER_CONFIG;
    process.env.REVIEWLAB_USER_CONFIG = join(fixture.root, '..private', 'config.json');
    try {
      await expect(loadTarget(fixture.root)).rejects.toThrow(/outside/);
    } finally {
      if (previousConfig === undefined) delete process.env.REVIEWLAB_USER_CONFIG;
      else process.env.REVIEWLAB_USER_CONFIG = previousConfig;
    }
    const executable = join(fixture.root, 'reviewlab');
    await writeFile(executable, 'not executable');
    const alias = join(directory, 'alias');
    await symlink(executable, alias);
    await expect(resolveExecutable(fixture.root, alias)).rejects.toThrow(/outside/);
    await expect(resolveExecutable(fixture.root, executable)).rejects.toThrow(/outside/);
  } finally {
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('extension bridge invokes installed ESM CLI through explicit Node without shell interpolation and stops on dispose', async () => {
  const fixture = await createGitFixture();
  const directory = await mkdtemp(join(tmpdir(), 'reviewlab-cli-bridge-'));
  try {
    const script = join(directory, 'installed cli.mjs');
    await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)));');
    const args = ['literal; echo should-not-run', 'a path with spaces'];
    await expect(runCli(script, fixture.root, args, undefined, process.execPath)).resolves.toEqual([
      ...args,
      '--repo',
      fixture.root,
      '--json',
    ]);
    await writeFile(script, 'setTimeout(() => console.log("{}"), 30000);');
    const controller = new AbortController();
    const request = runCli(script, fixture.root, [], controller.signal, process.execPath);
    controller.abort();
    await expect(request).rejects.toThrow(/failed or timed out/);
  } finally {
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
