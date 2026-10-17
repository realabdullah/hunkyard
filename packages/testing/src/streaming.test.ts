import { createServer } from 'node:http';
import { type ChatDelta, chatDeltas, createModelGateway } from '@reviewlab/agents';
import type { ModelTarget } from '@reviewlab/domain';
import { describe, expect, test } from 'vitest';

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

async function* from(...chunks: string[]) {
  yield* chunks;
}
const collect = async <T>(deltas: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const delta of deltas) out.push(delta);
  return out;
};

describe('chat stream parsing', () => {
  test('Ollama NDJSON lines split across chunks yield text in order and report length stops', async () => {
    const deltas = await collect(
      chatDeltas(
        'ollama',
        from(
          '{"message":{"content":"Hel"},"done":false}\n{"mess',
          'age":{"content":"lo"},"done":false}\r\n\n',
          '{"message":{"content":""},"done":true,"done_reason":"length"}\n',
        ),
      ),
    );
    expect(deltas).toEqual([{ text: 'Hel' }, { text: 'lo' }, { done: true, truncated: true }]);
  });

  test('OpenAI-compatible SSE ignores comments and role-only chunks and ends at [DONE]', async () => {
    const deltas = await collect(
      chatDeltas(
        'lm-studio',
        from(
          ': keepalive\n\n',
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\r\n\r\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ),
      ),
    );
    expect(deltas).toEqual([{ text: 'Hi' }, { done: true, truncated: false }]);
  });

  test('a stream without its end marker, or reporting an error, fails instead of saving a partial answer', async () => {
    await expect(
      collect(chatDeltas('ollama', from('{"message":{"content":"Half"},"done":false}\n'))),
    ).rejects.toThrow('ended early');
    await expect(
      collect(
        chatDeltas('llama-cpp', from('data: {"choices":[{"delta":{"content":"Half"}}]}\n\n')),
      ),
    ).rejects.toThrow('ended early');
    await expect(
      collect(chatDeltas('ollama', from('{"error":"model not found"}\n'))),
    ).rejects.toThrow('model not found');
    await expect(collect(chatDeltas('lm-studio', from('data: {oops}\n\n')))).rejects.toThrow(
      'invalid JSON',
    );
  });
});

describe('streaming egress', () => {
  test('forbidden destinations never reach the streaming transport', async () => {
    let calls = 0;
    const gateway = createModelGateway(undefined, undefined, async function* () {
      calls += 1;
      yield '';
    });
    const signal = new AbortController().signal;
    for (const endpoint of ['http://localhost:11434', 'http://10.0.0.1', 'http://example.test'])
      await expect(
        collect(
          chatDeltas('ollama', gateway.stream({ ...target, endpoint }, '/api/chat', {}, signal)),
        ),
      ).rejects.toThrow();
    await expect(
      collect(
        gateway.stream(
          { ...target, provider: 'openai', endpoint: 'https://api.openai.com', cloudConsent: true },
          '/v1/chat/completions',
          {},
          signal,
        ),
      ),
    ).rejects.toThrow('Local-only');
    await expect(
      collect(gateway.stream({ ...target, model: 'gpt-oss:cloud' }, '/api/chat', {}, signal)),
    ).rejects.toThrow('Cloud-backed');
    expect(calls).toBe(0);
  });

  test('a loopback Ollama runtime streams tokens through the default transport as they are written', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toMatchObject({ stream: true });
      response.setHeader('content-type', 'application/x-ndjson');
      response.write('{"message":{"content":"first"},"done":false}\n');
      await gate;
      response.end('{"message":{"content":" second"},"done":true,"done_reason":"stop"}\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const seen: ChatDelta[] = [];
      for await (const delta of chatDeltas(
        'ollama',
        createModelGateway().stream(
          { ...target, endpoint: `http://127.0.0.1:${address.port}` },
          '/api/chat',
          { stream: true },
          new AbortController().signal,
        ),
      )) {
        seen.push(delta);
        // The first token arrives while the runtime is still holding the response open.
        if (seen.length === 1) release();
      }
      expect(seen).toEqual([
        { text: 'first' },
        { text: ' second' },
        { done: true, truncated: false },
      ]);
    } finally {
      release();
      server.close();
    }
  });
});
