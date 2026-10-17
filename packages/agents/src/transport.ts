import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isHostedProvider, type ModelTarget, validateTarget } from '@reviewlab/domain';

export type ModelTransport = (
  url: URL,
  body: unknown | undefined,
  signal: AbortSignal,
  key?: string,
) => Promise<unknown>;
export { validateTarget } from '@reviewlab/domain';

const requestJson: ModelTransport = (url, body, signal, key) =>
  new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: data ? 'POST' : 'GET',
        signal,
        agent: false,
        headers: {
          accept: 'application/json',
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
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            response.destroy();
            reject(new Error('Model response exceeds 2 MiB.'));
          } else chunks.push(chunk);
        });
        response.on('error', () => reject(new Error('Model response interrupted.')));
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
          } catch {
            reject(new Error('Model endpoint returned invalid JSON.'));
          }
        });
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

export type SecretResolver = (target: ModelTarget) => Promise<string | undefined>;
export const createModelGateway = (
  transport: ModelTransport = requestJson,
  resolveSecret?: SecretResolver,
) => ({
  request: async (
    target: ModelTarget,
    path: string,
    body: unknown | undefined,
    signal: AbortSignal,
  ): Promise<unknown> => {
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
    return transport(new URL(operation, base), body, signal, key);
  },
});
