import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCorrectnessReviewer } from '@hunkyard/agents';
import { loadTarget, resolvePolicy, updateConfig } from '@hunkyard/context';
import { createReviewService } from '@hunkyard/core';
import { changedLines, type ModelTarget, validateFindings } from '@hunkyard/domain';
import { captureStaged } from '@hunkyard/git';
import { createApi } from '@hunkyard/server/app';
import { createFileSessionStore, validateSnapshot } from '@hunkyard/storage';
import { expect, test } from 'vitest';
import { createGitFixture } from './git-fixture';

const withSetup = async (
  run: (deps: {
    root: string;
    git: Awaited<ReturnType<typeof createGitFixture>>['git'];
    target: ModelTarget;
    snapshot: Awaited<ReturnType<typeof captureStaged>>;
    policy: Awaited<ReturnType<typeof resolvePolicy>>;
  }) => Promise<void>,
) => {
  const fixture = await createGitFixture();
  const configDir = await mkdtemp(join(tmpdir(), 'hunkyard-config-test-'));
  const previous = process.env.HUNKYARD_USER_CONFIG;
  process.env.HUNKYARD_USER_CONFIG = join(configDir, 'config.json');
  try {
    await writeFile(join(fixture.root, 'example.ts'), 'export const value = 2;\n');
    await fixture.git('add', 'example.ts');
    const snapshot = await captureStaged(fixture.root);
    const target = await loadTarget(fixture.root);
    const policy = await resolvePolicy(fixture.root);
    await run({ ...fixture, snapshot, target, policy });
  } finally {
    if (previous === undefined) delete process.env.HUNKYARD_USER_CONFIG;
    else process.env.HUNKYARD_USER_CONFIG = previous;
    await fixture.dispose();
    await rm(configDir, { recursive: true, force: true });
  }
};
const draft = {
  file: 'example.ts',
  line: 1,
  side: 'new' as const,
  severity: 'major' as const,
  title: 'Fixture defect',
  explanation: 'Synthetic contract finding',
  evidence: 'value = 2',
  recommendation: 'Fixture fix',
};

test('retained snapshot survives index replacement/object pruning and rejects tampering or replacement', async () => {
  await withSetup(async ({ root, git, snapshot, policy, target }) => {
    const store = createFileSessionStore(root);
    const service = createReviewService({
      root,
      store,
      captureStaged: async () => snapshot,
      resolvePolicy: async () => policy,
      loadTarget: async () => target,
      agent: { review: async () => [draft] },
    });
    const session = await service.start();
    await service.execute(session.id);
    await writeFile(join(root, 'example.ts'), 'new live bytes\n');
    await git('add', 'example.ts');
    await git('prune', '--expire=now');
    const saved = await createFileSessionStore(root).get(session.id);
    expect(saved?.status).toBe('completed');
    expect(
      saved?.snapshot.sources.find((source) => source.oid === snapshot.changes[0]?.newOid)?.text,
    ).toContain('value = 2');
    expect(saved?.findings[0]).toMatchObject({
      snapshotId: snapshot.id,
      policyHash: policy.hash,
      model: target.model,
      provider: 'ollama',
    });
    expect(() => validateSnapshot({ ...snapshot, diff: 'tampered' })).toThrow('integrity');
    const source = snapshot.sources[0];
    expect(() =>
      validateSnapshot({
        ...snapshot,
        sources: [{ ...source, bytes: Buffer.from('wrong').toString('base64') }],
      }),
    ).toThrow('integrity');
    if (!saved) throw new Error('Missing session');
    await expect(
      store.save({
        ...saved,
        revision: saved.revision + 1,
        snapshot: { ...snapshot, createdAt: '2026-10-14T01:00:00.000Z' },
      }),
    ).rejects.toThrow('immutable');
    await expect(store.save(saved)).rejects.toThrow('revision conflict');
    await rm(join(root, '.hunkyard', 'snapshots-v2', `${snapshot.id}.json`));
    await expect(store.get(session.id)).rejects.toThrow('Immutable snapshot is missing');
  });
});

test('source anchoring rejects invented/context/binary lines and accepts deletion and quoted paths', async () => {
  await withSetup(async ({ root, git, snapshot }) => {
    expect(validateFindings(snapshot, [draft])).toHaveLength(1);
    for (const finding of [
      { ...draft, file: 'other.ts' },
      { ...draft, line: 3 },
      { ...draft, evidence: 'invented' },
    ])
      expect(() => validateFindings(snapshot, [finding])).toThrow();
    const deletion = { ...draft, side: 'old' as const, evidence: 'value = 1' };
    expect(validateFindings(snapshot, [deletion])).toHaveLength(1);
    const name = 'ü\tname.ts';
    await writeFile(join(root, name), 'new content\n');
    await git('add', name);
    const unusual = await captureStaged(root);
    expect(changedLines(unusual).get(`new:${name}`)?.has(1)).toBe(true);
  });
});

test('bounded repair accepts a valid response and invalid output fails without fabricated findings', async () => {
  await withSetup(async ({ snapshot, target }) => {
    let calls = 0;
    const reviewer = createCorrectnessReviewer(async () => ({
      message: { content: ++calls === 1 ? 'bad JSON' : JSON.stringify({ findings: [draft] }) },
    }));
    const input = {
      snapshot,
      target,
      instructions: [],
      exclusions: [],
      signal: new AbortController().signal,
    };
    expect(await reviewer.review(input)).toEqual([draft]);
    expect(calls).toBe(2);
    calls = 0;
    const broken = createCorrectnessReviewer(async () => {
      calls += 1;
      return { message: { content: JSON.stringify({ findings: [{ ...draft, line: 99 }] }) } };
    });
    await expect(broken.review(input)).rejects.toThrow('after one repair');
    expect(calls).toBe(2);
  });
});

test('cancellation is persistent and late completion cannot overwrite it; repeat execute is idempotent', async () => {
  await withSetup(async ({ root, snapshot, target, policy }) => {
    let finish: ((value: (typeof draft)[]) => void) | undefined;
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = createReviewService({
      root,
      store: createFileSessionStore(root),
      captureStaged: async () => snapshot,
      resolvePolicy: async () => policy,
      loadTarget: async () => target,
      agent: {
        review: async () => {
          started?.();
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    });
    const session = await service.start();
    const running = service.execute(session.id);
    await ready;
    await service.cancel(session.id);
    finish?.([draft]);
    await running;
    await service.execute(session.id);
    expect((await service.get(session.id))?.status).toBe('cancelled');
    expect((await service.get(session.id))?.findings).toEqual([]);
    const second = await service.start();
    const secondRun = service.execute(second.id);
    await expect.poll(async () => (await service.get(second.id))?.status).toBe('running');
    await service.shutdown();
    finish?.([]);
    await secondRun;
    expect((await service.get(second.id))?.status).toBe('cancelled');
    expect((await service.get(second.id))?.error).toContain('shutdown');
  });
});

test('rules are inspectable, exclusions are explicit, and repository config cannot grant cloud access', async () => {
  await withSetup(async ({ root }) => {
    await updateConfig(root, { rules: ['Global priority'], allowCloud: false });
    await mkdir(join(root, '.hunkyard'));
    await writeFile(
      join(root, '.hunkyard', 'config.json'),
      JSON.stringify({ rules: ['Project advisory'], exclude: ['vendor/'] }),
    );
    await writeFile(join(root, 'AGENTS.md'), 'Repository advisory');
    const policy = await resolvePolicy(root);
    expect(policy.instructions.map((line) => line.split(':')[0])).toEqual([
      'Repository advisory source AGENTS.md',
      'Project advisory rules',
      'User rule',
    ]);
    expect(policy.exclusions).toEqual(['vendor/']);
    expect(policy.sources[0]?.hash).toBe(
      createHash('sha256').update('Repository advisory').digest('hex'),
    );
    await writeFile(
      join(root, '.hunkyard', 'config.json'),
      JSON.stringify({ privacy: 'cloud-allowed', cloudConsent: true }),
    );
    await expect(resolvePolicy(root)).rejects.toThrow('only rules and exclude');
    expect((await loadTarget(root)).cloudConsent).toBe(false);
  });
});

test('Hono requires auth, exact Host/Origin and CSRF; authorized local flow captures and completes', async () => {
  await withSetup(async ({ root, snapshot, target, policy }) => {
    const service = createReviewService({
      root,
      store: createFileSessionStore(root),
      captureStaged: async () => snapshot,
      resolvePolicy: async () => policy,
      loadTarget: async () => target,
      agent: { review: async () => [draft] },
    });
    const token = 'fixture-token';
    const origin = 'http://127.0.0.1:4317';
    const app = createApi({
      service,
      token,
      origin,
      target: async () => target,
      configure: async () => target,
      probe: async () => ({ ready: true }),
    });
    const headers = {
      host: '127.0.0.1:4317',
      authorization: `Bearer ${token}`,
      origin,
      'x-hunkyard-csrf': '1',
    };
    expect(
      (await app.request(`${origin}/api/v1/sessions`, { headers: { host: headers.host } })).status,
    ).toBe(401);
    expect(
      (
        await app.request(`${origin}/api/v1/sessions`, {
          headers: { ...headers, host: 'evil.test' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`${origin}/api/v1/sessions`, {
          method: 'POST',
          headers: { ...headers, origin: 'https://evil.test' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`${origin}/api/v1/sessions`, {
          method: 'POST',
          headers: { ...headers, 'x-hunkyard-csrf': '0' },
        })
      ).status,
    ).toBe(403);
    const response = await app.request(`${origin}/api/v1/sessions`, { method: 'POST', headers });
    expect(response.status).toBe(202);
    const session = (await response.json()) as { id: string };
    // Wait for the independently persisted execution, without issuing model requests twice.
    await expect.poll(async () => (await service.get(session.id))?.status).toBe('completed');
    const result = await app.request(`${origin}/api/v1/sessions/${session.id}`, { headers });
    expect(result.status).toBe(200);
    expect(((await result.json()) as { findings: unknown[] }).findings).toHaveLength(1);
  });
});

test('project exclusions and redaction apply before hosted request construction, including binary metadata', async () => {
  await withSetup(async ({ root, git, snapshot, target }) => {
    await writeFile(join(root, 'private.dat'), Buffer.from([0, 1, 255]));
    await git('add', 'private.dat');
    const withBinary = await captureStaged(root);
    let outbound = '';
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'synthetic-test-key';
    try {
      const key = ['sk-', 'x'.repeat(20)].join('');
      const reviewer = createCorrectnessReviewer(async (_url, body) => {
        outbound = JSON.stringify(body);
        return { choices: [{ message: { content: '{"findings":[]}' } }] };
      });
      await reviewer.review({
        snapshot: withBinary,
        instructions: [`api_key="${key}"`],
        exclusions: ['private.dat'],
        target: {
          ...target,
          provider: 'openai',
          endpoint: 'https://api.openai.com',
          privacy: 'cloud-allowed',
          cloudConsent: true,
          approvedHostedOrigins: ['https://api.openai.com'],
        },
        signal: new AbortController().signal,
      });
      expect(outbound).not.toContain('private.dat');
      expect(outbound).not.toContain(key);
      expect(outbound).toContain('[REDACTED]');
      expect(outbound).toContain('value = 2');
      expect(snapshot.sources.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });
});

test('API rejects oversized mutation bodies and Unicode authorization without runtime errors', async () => {
  await withSetup(async ({ root, snapshot, target, policy }) => {
    const service = createReviewService({
      root,
      store: createFileSessionStore(root),
      captureStaged: async () => snapshot,
      resolvePolicy: async () => policy,
      loadTarget: async () => target,
      agent: { review: async () => [] },
    });
    const origin = 'http://127.0.0.1:4317';
    const app = createApi({
      service,
      token: 'fixture-token',
      origin,
      target: async () => target,
      configure: async () => target,
      probe: async () => ({ ready: true }),
    });
    const headers = {
      host: '127.0.0.1:4317',
      authorization: 'Bearer fixture-token',
      origin,
      'x-hunkyard-csrf': '1',
      'content-type': 'application/json',
    };
    expect(
      (
        await app.request(`${origin}/api/v1/config`, {
          method: 'POST',
          headers,
          body: 'x'.repeat(65_000),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await app.request(`${origin}/api/v1/health`, {
          headers: { ...headers, authorization: `Bearer ${'é'.repeat(13)}` },
        })
      ).status,
    ).toBe(401);
  });
});

test('unchanged context lines cannot become findings, and user consent config cannot live inside the repository', async () => {
  await withSetup(async ({ root, git }) => {
    await writeFile(join(root, 'example.ts'), 'const unchanged = 1;\nconst changed = 1;\n');
    await git('add', 'example.ts');
    await git('commit', '-m', 'test: establish context');
    await writeFile(join(root, 'example.ts'), 'const unchanged = 1;\nconst changed = 2;\n');
    await git('add', 'example.ts');
    const snapshot = await captureStaged(root);
    expect(() =>
      validateFindings(snapshot, [{ ...draft, line: 1, evidence: 'unchanged = 1' }]),
    ).toThrow('outside');
    expect(
      validateFindings(snapshot, [{ ...draft, line: 2, evidence: 'changed = 2' }]),
    ).toHaveLength(1);
    process.env.HUNKYARD_USER_CONFIG = join(root, 'user-config.json');
    await expect(updateConfig(root, { allowCloud: true })).rejects.toThrow('outside');
  });
});
