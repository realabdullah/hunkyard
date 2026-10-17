import {
  type ModelTarget,
  OllamaChatSchema,
  OllamaModelsSchema,
  OpenAIChatSchema,
  OpenAIModelsSchema,
} from '@reviewlab/domain';
import { chatBody } from './requests';
import {
  createModelGateway,
  type ModelTransport,
  type SecretResolver,
  validateTarget,
} from './transport';

export type ModelCapabilities = {
  ready: boolean;
  models: string[];
  structuredOutput: 'verified' | 'failed' | 'unavailable';
  toolUse: 'untested';
  contextWindow: number | null;
  contextWindowSource: 'user-hint' | 'unknown';
  checkedAt: string;
  limitation: string;
};
const cache = new Map<string, { expires: number; result: ModelCapabilities }>();
// Explicit opt-in inference probe: contains no repository source and never routes to another model.
export const probeModelCapabilities = async (
  target: ModelTarget,
  signal = new AbortController().signal,
  transport?: ModelTransport,
  resolveSecret?: SecretResolver,
): Promise<ModelCapabilities> => {
  validateTarget(target);
  const key = JSON.stringify(target);
  const cached = cache.get(key);
  if (!transport && cached && cached.expires > Date.now()) return cached.result;
  const endpoint = await probeModel(target, signal, transport, resolveSecret);
  const result: ModelCapabilities = {
    ...endpoint,
    structuredOutput: 'unavailable',
    toolUse: 'untested',
    contextWindow: target.contextWindow ?? null,
    contextWindowSource: target.contextWindow ? 'user-hint' : 'unknown',
    checkedAt: new Date().toISOString(),
    limitation:
      'Tools are untested; reviews use no tools. A context-window hint is not runtime verification.',
  };
  if (endpoint.ready) {
    try {
      const response = await createModelGateway(transport, resolveSecret).request(
        target,
        target.provider === 'ollama' ? '/api/chat' : '/v1/chat/completions',
        chatBody(
          target,
          [{ role: 'user', content: 'Return exactly the JSON object {"reviewlab_probe":"ok"}.' }],
          64,
          target.provider === 'deepseek'
            ? undefined
            : {
                type: 'object',
                properties: { reviewlab_probe: { type: 'string', enum: ['ok'] } },
                required: ['reviewlab_probe'],
                additionalProperties: false,
              },
        ),
        AbortSignal.any([signal, AbortSignal.timeout(Math.min(target.timeoutMs, 30_000))]),
      );
      const raw =
        target.provider === 'ollama'
          ? OllamaChatSchema.parse(response).message.content
          : OpenAIChatSchema.parse(response).choices[0]?.message.content;
      if (typeof raw !== 'string') throw new Error('Missing JSON output.');
      const parsed: unknown = JSON.parse(raw);
      result.structuredOutput =
        JSON.stringify(parsed) === '{"reviewlab_probe":"ok"}' ? 'verified' : 'failed';
    } catch (error) {
      if (signal.aborted) throw error;
      result.structuredOutput = 'failed';
      result.limitation +=
        ' Schema probe failed; select JSON or tool-less text mode and validate a smoke review.';
    }
  }
  if (!transport) {
    if (cache.size >= 100) cache.clear();
    cache.set(key, { expires: Date.now() + 60_000, result });
  }
  return result;
};

export const probeModel = async (
  target: ModelTarget,
  signal = new AbortController().signal,
  transport?: ModelTransport,
  resolveSecret?: SecretResolver,
) => {
  const response = await createModelGateway(transport, resolveSecret).request(
    target,
    target.provider === 'ollama' ? '/api/tags' : '/v1/models',
    undefined,
    AbortSignal.any([signal, AbortSignal.timeout(Math.min(target.timeoutMs, 5000))]),
  );
  const names =
    target.provider === 'ollama'
      ? OllamaModelsSchema.parse(response).models.map((model) => model.name)
      : OpenAIModelsSchema.parse(response).data.map((model) => model.id);
  return { ready: names.includes(target.model), models: names };
};
