import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isHostedProvider, type ModelTarget, validateTarget } from '@hunkyard/domain';

export type ModelTransport = (
  url: URL,
  body: unknown | undefined,
  signal: AbortSignal,
  key?: string,
) => Promise<unknown>;
/** Streams the raw response body as text; framing is parsed by the caller. */
export type ModelStreamTransport = (
  url: URL,
  body: unknown,
  signal: AbortSignal,
  key?: string,
) => AsyncIterable<string>;
export { validateTarget } from '@hunkyard/domain';

/** Opens one request to the validated destination; redirects and non-2xx answers are refused. */
const open = (
  url: URL,
  body: unknown | undefined,
  signal: AbortSignal,
  key: string | undefined,
  accept: string,
) =>
  new Promise<IncomingMessage>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: data ? 'POST' : 'GET',
        signal,
        agent: false,
        headers: {
          accept,
          ...(data
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
            : {}),
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
      },
      (response) => {
        // Never follow a redirect, including one returned by a local runtime.
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy();
          reject(new Error(`Model endpoint returned HTTP ${response.statusCode ?? 0}.`));
          return;
        }
        resolve(response);
      },
    );
    request.on('error', () =>
      reject(
        new Error(
          signal.aborted ? 'Model request cancelled or timed out.' : 'Model endpoint unavailable.',
        ),
      ),
    );
    request.end(data);
  });

const limit = 2 * 1024 * 1024;

/** Reads a response body as UTF-8 text chunks, capped at 2 MiB in total. */
async function* chunks(response: IncomingMessage, signal: AbortSignal): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let size = 0;
  try {
    for await (const chunk of response as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > limit) throw new Error('Model response exceeds 2 MiB.');
      yield decoder.decode(chunk, { stream: true });
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Model response exceeds')) throw error;
    throw new Error(
      signal.aborted ? 'Model request cancelled or timed out.' : 'Model response interrupted.',
    );
  } finally {
    response.destroy();
  }
}

const requestJson: ModelTransport = async (url, body, signal, key) => {
  let text = '';
  for await (const chunk of chunks(await open(url, body, signal, key, 'application/json'), signal))
    text += chunk;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Model endpoint returned invalid JSON.');
  }
};

const requestStream: ModelStreamTransport = async function* (url, body, signal, key) {
  yield* chunks(
    await open(url, body, signal, key, 'application/x-ndjson, text/event-stream'),
    signal,
  );
};

export type SecretResolver = (target: ModelTarget) => Promise<string | undefined>;
export const createModelGateway = (
  transport: ModelTransport = requestJson,
  resolveSecret?: SecretResolver,
  streamTransport: ModelStreamTransport = requestStream,
) => {
  // Every operation, streaming or not, passes the same destination and key checks first.
  const resolve = async (target: ModelTarget, path: string) => {
    const base = validateTarget(target);
    const allowed =
      target.provider === 'ollama'
        ? ['/api/chat', '/api/tags', '/api/embed']
        : [
            '/v1/chat/completions',
            '/v1/models',
            ...(isHostedProvider(target.provider) ? [] : ['/v1/embeddings']),
          ];
    if (!allowed.includes(path)) throw new Error('Undeclared model operation.');
    const storedKey = await resolveSecret?.(target);
    const environmentKey =
      target.provider === 'openai'
        ? 'OPENAI_API_KEY'
        : target.provider === 'deepseek'
          ? 'DEEPSEEK_API_KEY'
          : target.provider === 'agentrouter'
            ? 'AGENTROUTER_API_KEY'
            : undefined;
    const key = (environmentKey ? process.env[environmentKey] : undefined) ?? storedKey;
    if (isHostedProvider(target.provider) && !key)
      throw new Error(
        `${environmentKey} is required on the server (environment or saved provider secret).`,
      );
    const operation = target.provider === 'deepseek' ? path.replace(/^\/v1/, '') : path;
    return { url: new URL(operation, base), key };
  };
  return {
    request: async (
      target: ModelTarget,
      path: string,
      body: unknown | undefined,
      signal: AbortSignal,
    ): Promise<unknown> => {
      const { url, key } = await resolve(target, path);
      return transport(url, body, signal, key);
    },
    stream: async function* (
      target: ModelTarget,
      path: '/api/chat' | '/v1/chat/completions',
      body: unknown,
      signal: AbortSignal,
    ): AsyncGenerator<string> {
      const { url, key } = await resolve(target, path);
      yield* streamTransport(url, body, signal, key);
    },
  };
};
