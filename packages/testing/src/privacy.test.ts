import { createServer } from 'node:http';
import {
  createCorrectnessReviewer,
  createModelGateway,
  probeModel,
  redactSecrets,
} from '@reviewlab/agents';
import type { ModelTarget } from '@reviewlab/domain';
import { describe, expect, test } from 'vitest';
import { fixtureSnapshot } from './replay';

const target: ModelTarget = {
  provider: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  model: 'fixture',
  privacy: 'local-only',
  cloudConsent: false,
  repository: 'fixture',
  timeoutMs: 1000,
  maxTokens: 512,
};

describe('local-only egress gate', () => {
  test('forbidden DNS/IP/provider destinations never reach the outbound transport', async () => {
    let calls = 0;
    const gateway = createModelGateway(async () => {
      calls += 1;
      return {};
    });
    for (const endpoint of [
      'http://localhost:11434',
      'http://example.test',
      'http://10.0.0.1',
      'http://169.254.169.254',
      'http://127.0.0.1.example.test',
      'http://user:password@127.0.0.1',
      'http://127.0.0.1/?redirect=remote',
      'file:///tmp/socket',
    ])
      await expect(
        gateway.request({ ...target, endpoint }, '/api/chat', {}, new AbortController().signal),
      ).rejects.toThrow();
    await expect(
      gateway.request(
        { ...target, provider: 'openai', endpoint: 'https://api.openai.com', cloudConsent: true },
        '/v1/chat/completions',
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow('Local-only');
    await expect(
      gateway.request(
        {
          ...target,
          provider: 'openai',
          privacy: 'cloud-allowed',
          endpoint: 'https://api.openai.com',
        },
        '/v1/chat/completions',
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow('consent');
    await expect(
      gateway.request(target, '/api/pull', {}, new AbortController().signal),
    ).rejects.toThrow('Undeclared');
    expect(calls).toBe(0);
  });

  test('real loopback runtime redirect is refused without contacting the redirect destination', async () => {
    let leaked = 0;
    const destination = createServer((_req, res) => {
      leaked += 1;
      res.end('{}');
    });
    const runtime = createServer((_req, res) => {
      const address = destination.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');
      res.writeHead(302, { location: `http://127.0.0.1:${address.port}/source` });
      res.end();
    });
    await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve));
    try {
      const address = runtime.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');
      await expect(
        probeModel({ ...target, endpoint: `http://127.0.0.1:${address.port}` }),
      ).rejects.toThrow('HTTP 302');
      expect(leaked).toBe(0);
    } finally {
      runtime.closeAllConnections();
      destination.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => runtime.close(() => resolve())),
        new Promise<void>((resolve) => destination.close(() => resolve())),
      ]);
    }
  });

  test('hosted routing requires consent, redacts input and never silently falls back', async () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'synthetic-test-key';
    try {
      const cloud = {
        ...target,
        provider: 'openai' as const,
        endpoint: 'https://api.openai.com',
        privacy: 'cloud-allowed' as const,
        cloudConsent: true,
      };
      const calls: string[] = [];
      const gateway = createModelGateway(async (url, body) => {
        calls.push(url.origin);
        expect(body).toEqual({ synthetic: true });
        return { ok: true };
      });
      await gateway.request(
        cloud,
        '/v1/chat/completions',
        { synthetic: true },
        new AbortController().signal,
      );
      expect(calls).toEqual(['https://api.openai.com']);
      const reviewer = createCorrectnessReviewer(async (url) => {
        calls.push(url.origin);
        throw new Error('Endpoint unavailable');
      });
      await expect(
        reviewer.review({
          snapshot: fixtureSnapshot('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+code\n'),
          instructions: [],
          exclusions: [],
          target,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('Endpoint unavailable');
      expect(calls).toEqual(['https://api.openai.com', 'http://127.0.0.1:11434']);
      const credential = ['sk-', 'x'.repeat(20)].join('');
      expect(redactSecrets(`api_key="${credential}"`)).not.toContain(credential);
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });
});
