import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCorrectnessReviewer,
  createModelGateway,
  probeModelCapabilities,
} from '@hunkyard/agents';
import { loadProviderSecret, providerSecretPath, saveProviderSecret } from '@hunkyard/context';
import { type ModelTarget, ModelTargetSchema } from '@hunkyard/domain';
import { expect, test } from 'vitest';
import { fixtureSnapshot } from './replay';

const target = (provider: ModelTarget['provider']): ModelTarget =>
  ModelTargetSchema.parse({
    provider,
    model: 'fixture',
    endpoint: 'http://127.0.0.1:8080/v1',
    privacy: 'local-only',
    cloudConsent: false,
    repository: 'fixture',
    maxTokens: 256,
  });
const snapshot = fixtureSnapshot(
  'diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-a\n+b\n',
);

test('actual loopback compatible runtimes list models, probe schema and review without tools', async () => {
  const observed: { path: string | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: Record<string, unknown> = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : {};
    observed.push({ path: request.url, body });
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        request.url === '/v1/models'
          ? { data: [{ id: 'fixture' }] }
          : {
              choices: [
                {
                  message: {
                    content: JSON.stringify(
                      'response_format' in body &&
                        JSON.stringify(body.response_format).includes('hunkyard_probe')
                        ? { hunkyard_probe: 'ok' }
                        : { findings: [] },
                    ),
                  },
                  finish_reason: 'stop',
                },
              ],
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port.');
  try {
    for (const provider of ['lm-studio', 'llama-cpp', 'compatible'] as const) {
      const configured = { ...target(provider), endpoint: `http://127.0.0.1:${address.port}/v1` };
      expect(await probeModelCapabilities(configured)).toMatchObject({
        ready: true,
        structuredOutput: 'verified',
        toolUse: 'untested',
      });
      const progress: string[] = [];
      expect(
        await createCorrectnessReviewer().review({
          snapshot,
          target: configured,
          instructions: [],
          exclusions: [],
          signal: new AbortController().signal,
          onProgress: async ({ stage }) => {
            progress.push(stage);
          },
        }),
      ).toEqual([]);
      expect(progress).toEqual(['request', 'response']);
    }
    expect(observed.filter((entry) => entry.path === '/v1/chat/completions')).toHaveLength(6);
    for (const { body } of observed) {
      expect(body).not.toHaveProperty('tools');
      if (body.model) expect(body).toHaveProperty('max_tokens');
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('local adapters reject remote and credentialled endpoints before transport or secrets', async () => {
  let calls = 0;
  const gateway = createModelGateway(
    async () => {
      calls += 1;
      return {};
    },
    async () => {
      calls += 1;
      return 'secret';
    },
  );
  for (const provider of ['lm-studio', 'llama-cpp', 'compatible'] as const)
    for (const endpoint of [
      'http://localhost:8080',
      'http://10.0.0.1:8080',
      'http://127.0.0.1.evil.test',
      'http://169.254.169.254',
      'http://user:key@127.0.0.1',
      'http://127.0.0.1/proxy',
    ])
      await expect(
        gateway.request(
          { ...target(provider), endpoint },
          '/v1/chat/completions',
          {},
          new AbortController().signal,
        ),
      ).rejects.toThrow();
  expect(calls).toBe(0);
});

test('repair shares review budget and context limits stop requests before inference', async () => {
  let calls = 0;
  const reviewer = createCorrectnessReviewer(async () => {
    calls += 1;
    return { choices: [{ message: { content: 'invalid' } }] };
  });
  const input = {
    snapshot,
    target: { ...target('compatible'), maxReviewTokens: 1800 },
    instructions: [],
    exclusions: [],
    signal: new AbortController().signal,
  };
  await expect(reviewer.review(input)).rejects.toThrow('budget');
  expect(calls).toBe(1);
  await expect(
    reviewer.review({ ...input, target: { ...input.target, contextWindow: 1024 } }),
  ).rejects.toThrow('context-window');
  expect(calls).toBe(1);
});

test('failed structured probe makes limitations explicit and performs no fallback', async () => {
  let calls = 0;
  const result = await probeModelCapabilities(
    target('compatible'),
    undefined,
    async (_url, body) => {
      calls += 1;
      if (!body) return { data: [{ id: 'fixture' }] };
      return { choices: [{ message: { content: '{"hunkyard_probe":"wrong"}' } }] };
    },
  );
  expect(result.structuredOutput).toBe('failed');
  expect(calls).toBe(2);
});

test('provider secrets are private, separate, removable and refused inside repo or symlink escapes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hunkyard-secret-test-'));
  const previous = process.env.HUNKYARD_USER_CONFIG;
  const root = join(directory, 'repo');
  await mkdir(root);
  process.env.HUNKYARD_USER_CONFIG = join(directory, 'private', 'config.json');
  try {
    await saveProviderSecret(root, 'openai', 'fixture-secret');
    expect(await loadProviderSecret(root, 'openai')).toBe('fixture-secret');
    expect(await readFile(providerSecretPath(), 'utf8')).toBe('{"openai":"fixture-secret"}');
    await chmod(providerSecretPath(), 0o644);
    await expect(loadProviderSecret(root, 'openai')).rejects.toThrow('private permissions');
    await chmod(providerSecretPath(), 0o600);
    await saveProviderSecret(root, 'openai', null);
    expect(await loadProviderSecret(root, 'openai')).toBeUndefined();
    process.env.HUNKYARD_USER_CONFIG = join(root, 'config.json');
    await expect(saveProviderSecret(root, 'openai', 'fixture-secret')).rejects.toThrow('outside');
    await symlink(root, join(directory, 'link'));
    process.env.HUNKYARD_USER_CONFIG = join(directory, 'link', 'nested', 'config.json');
    await expect(saveProviderSecret(root, 'openai', 'fixture-secret')).rejects.toThrow('outside');
  } finally {
    if (previous === undefined) delete process.env.HUNKYARD_USER_CONFIG;
    else process.env.HUNKYARD_USER_CONFIG = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt private credential JSON and unexpected keys never disclose credential excerpts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hunkyard-secret-error-'));
  const root = join(directory, 'repo');
  await mkdir(root);
  const previous = process.env.HUNKYARD_USER_CONFIG;
  process.env.HUNKYARD_USER_CONFIG = join(directory, 'private', 'config.json');
  try {
    await saveProviderSecret(root, 'openai', 'fixture-secret');
    for (const malformed of ['{"openai": fixture-secret}', '{"fixture-secret":"value"}']) {
      await writeFile(providerSecretPath(), malformed, { mode: 0o600 });
      await expect(loadProviderSecret(root, 'openai')).rejects.toThrow(
        'Invalid provider secret file.',
      );
      await expect(loadProviderSecret(root, 'openai')).rejects.not.toThrow('fixture-secret');
    }
  } finally {
    if (previous === undefined) delete process.env.HUNKYARD_USER_CONFIG;
    else process.env.HUNKYARD_USER_CONFIG = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
