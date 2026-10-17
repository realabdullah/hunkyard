import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCorrectnessReviewer,
  createModelGateway,
  probeModel,
  probeModelCapabilities,
} from '@reviewlab/agents';
import {
  configPath,
  loadAuthorizedProviderSecret,
  loadTarget,
  saveProviderSecret,
  updateConfig,
} from '@reviewlab/context';
import { createReviewPlan } from '@reviewlab/core';
import { assertCurrentAuthorization, ModelTargetSchema } from '@reviewlab/domain';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', 'openai-only-fixture');
  vi.stubEnv('DEEPSEEK_API_KEY', undefined);
  vi.stubEnv('AGENTROUTER_API_KEY', undefined);
});
afterEach(() => vi.unstubAllEnvs());

import { fixtureSnapshot } from './replay';

const hosted = (provider: 'deepseek' | 'agentrouter') =>
  ModelTargetSchema.parse({
    provider,
    model: provider === 'deepseek' ? 'deepseek-flash' : 'gpt-5.5',
    endpoint:
      provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://co.agentrouter.org/v1',
    privacy: 'cloud-allowed',
    cloudConsent: true,
    approvedHostedOrigins: [
      provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://co.agentrouter.org',
    ],
    repository: 'fixture',
  });

test('hosted adapters map exact paths, isolate keys, validate output, and use DeepSeek JSON mode', async () => {
  for (const provider of ['deepseek', 'agentrouter'] as const) {
    const target = hosted(provider);
    const requests: { path: string; body: unknown; key: string | undefined }[] = [];
    const transport = async (url: URL, body: unknown, _signal: AbortSignal, key?: string) => {
      requests.push({ path: url.pathname, body, key });
      return body === undefined
        ? { data: [{ id: target.model }] }
        : { choices: [{ message: { content: '{"findings":[]}' } }] };
    };
    const secret = async () => `${provider}-fixture-key`;
    expect((await probeModel(target, undefined, transport, secret)).ready).toBe(true);
    const reviewer = createCorrectnessReviewer(transport, secret);
    expect(
      await reviewer.review({
        snapshot: fixtureSnapshot(
          'diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-a\n+b\n',
        ),
        instructions: [],
        exclusions: [],
        target,
        signal: new AbortController().signal,
      }),
    ).toEqual([]);
    expect(requests.map((entry) => entry.path)).toEqual(
      provider === 'deepseek'
        ? ['/models', '/chat/completions']
        : ['/v1/models', '/v1/chat/completions'],
    );
    expect(requests.every((entry) => entry.key === `${provider}-fixture-key`)).toBe(true);
    expect(requests[1]?.body).toMatchObject({
      model: target.model,
      response_format: { type: 'json_object' },
      max_tokens: 4000,
      stream: false,
    });
    const variable = provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'AGENTROUTER_API_KEY';
    vi.stubEnv(variable, `${provider}-environment-key`);
    await probeModel(target, undefined, transport, secret);
    expect(requests.at(-1)?.key).toBe(`${provider}-environment-key`);
    vi.stubEnv(variable, undefined);
    if (provider === 'deepseek') {
      expect(requests[1]?.body).toMatchObject({ thinking: { type: 'disabled' } });
      await expect(
        reviewer.review({
          snapshot: fixtureSnapshot(
            'diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-a\n+b\n',
          ),
          instructions: [],
          exclusions: [],
          target: { ...target, structuredOutput: 'schema' },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/JSON mode/);
      const capability = await probeModelCapabilities(
        target,
        undefined,
        async (_url, body) =>
          body === undefined
            ? { data: [{ id: target.model }] }
            : { choices: [{ message: { content: '{"reviewlab_probe":"ok"}' } }] },
        secret,
      );
      expect(capability.structuredOutput).toBe('verified');
    }
  }
});

test('hosted providers refuse local-only, unapproved origins, operations, and cross-provider routes before transport', async () => {
  let requests = 0;
  const gateway = createModelGateway(
    async () => {
      requests++;
      return {};
    },
    async () => 'fixture-key',
  );
  for (const provider of ['deepseek', 'agentrouter'] as const) {
    const target = hosted(provider);
    for (const update of [
      { privacy: 'local-only' as const },
      { cloudConsent: false },
      { approvedHostedOrigins: [] },
      { endpoint: 'https://evil.test' },
      { endpoint: 'http://api.deepseek.com' },
      { endpoint: `${target.endpoint}?redirect=evil` },
      { endpoint: `${target.endpoint}/other` },
    ]) {
      await expect(
        gateway.request(
          { ...target, ...update },
          '/v1/chat/completions',
          {},
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    }
    await expect(
      gateway.request(target, '/v1/embeddings', {}, new AbortController().signal),
    ).rejects.toThrow(/Undeclared/);
  }
  expect(() =>
    createReviewPlan(hosted('deepseek'), {
      agentModels: {
        correctness: { provider: 'agentrouter', endpoint: 'https://co.agentrouter.org/v1' },
      },
    }),
  ).toThrow(/destination/);
  expect(() =>
    assertCurrentAuthorization(hosted('deepseek'), {
      ...hosted('deepseek'),
      approvedHostedOrigins: [],
    }),
  ).toThrow(/revoked/);
  expect(requests).toBe(0);
});

test('legacy OpenAI consent never authorizes a new destination, grants are repository/origin specific and revocation blocks repairs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reviewlab-hosted-'));
  const previous = process.env.REVIEWLAB_USER_CONFIG;
  process.env.REVIEWLAB_USER_CONFIG = join(directory, 'config.json');
  const root = await mkdtemp(join(tmpdir(), 'reviewlab-hosted-repo-'));
  const other = await mkdtemp(join(tmpdir(), 'reviewlab-other-repo-'));
  try {
    expect((await updateConfig(root, { allowCloud: true })).approvedHostedOrigins).toEqual([]);
    await updateConfig(root, {
      model: { provider: 'openai', endpoint: 'https://api.openai.com', privacy: 'cloud-allowed' },
      allowCloud: true,
    });
    const legacy = JSON.parse(await readFile(configPath(), 'utf8'));
    delete legacy.cloudDestinations;
    await writeFile(configPath(), JSON.stringify(legacy));
    await updateConfig(root, {
      model: {
        provider: 'deepseek',
        endpoint: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        privacy: 'cloud-allowed',
      },
    });
    expect((await loadTarget(root)).cloudConsent).toBe(false);
    const target = await updateConfig(root, { allowCloud: true });
    expect(target.cloudConsent).toBe(true);
    expect((await loadTarget(other)).cloudConsent).toBe(false);
    await saveProviderSecret(root, 'deepseek', 'fixture-deepseek-key');
    await saveProviderSecret(root, 'agentrouter', 'fixture-router-key');
    expect(await loadAuthorizedProviderSecret(root, target)).toBe('fixture-deepseek-key');
    expect(await readFile(configPath(), 'utf8')).not.toContain('fixture-deepseek-key');
    let calls = 0;
    const reviewer = createCorrectnessReviewer(
      async () => {
        calls++;
        await updateConfig(root, { allowCloud: false });
        return { choices: [{ message: { content: 'invalid JSON' } }] };
      },
      (selected) => loadAuthorizedProviderSecret(root, selected),
    );
    await expect(
      reviewer.review({
        snapshot: fixtureSnapshot(
          'diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-a\n+b\n',
        ),
        instructions: [],
        exclusions: [],
        target,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/revoked/);
    expect(calls).toBe(1);
    expect((await loadTarget(root)).approvedHostedOrigins).toEqual([]);
    await updateConfig(root, {
      model: {
        provider: 'agentrouter',
        endpoint: 'https://co.agentrouter.org/v1',
        model: 'gpt-5.5',
        privacy: 'cloud-allowed',
      },
      allowCloud: true,
    });
    await updateConfig(root, {
      model: {
        provider: 'agentrouter',
        endpoint: 'https://agentrouter.org/v1',
        model: 'gpt-5.5',
        privacy: 'cloud-allowed',
      },
    });
    expect((await loadTarget(root)).cloudConsent).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.REVIEWLAB_USER_CONFIG;
    else process.env.REVIEWLAB_USER_CONFIG = previous;
    await Promise.all(
      [directory, root, other].map((path) => rm(path, { recursive: true, force: true })),
    );
  }
});
