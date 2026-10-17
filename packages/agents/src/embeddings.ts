import { type ModelTarget, ModelTargetSchema, redactSecrets } from '@hunkyard/domain';
import { createModelGateway, type ModelTransport, validateTarget } from './transport';

export const createLocalEmbedder = (
  options: {
    model: string;
    endpoint: string;
    provider: 'ollama' | 'compatible';
    granted: boolean;
  },
  transport?: ModelTransport,
) => {
  if (options.granted !== true)
    throw new Error('Local embeddings require explicit per-run permission.');
  const target: ModelTarget = ModelTargetSchema.parse({
    ...options,
    privacy: 'local-only',
    repository: 'local-embeddings',
    cloudConsent: false,
  });
  validateTarget(target);
  const gateway = createModelGateway(transport);
  return {
    provenance: {
      version: 1 as const,
      provider: options.provider,
      model: options.model,
      endpoint: options.endpoint,
    },
    embed: async (texts: string[]): Promise<number[][]> => {
      if (
        !texts.length ||
        texts.length > 8 ||
        texts.some((text) => Buffer.byteLength(text) > 12000)
      )
        throw new Error('Embedding batch exceeds 8 inputs / 12 KB per input.');
      const input = texts.map(redactSecrets);
      const raw = await gateway.request(
        target,
        options.provider === 'ollama' ? '/api/embed' : '/v1/embeddings',
        options.provider === 'ollama'
          ? { model: target.model, input, truncate: false }
          : { model: target.model, input, encoding_format: 'float' },
        AbortSignal.timeout(30000),
      );
      if (!raw || typeof raw !== 'object') throw new Error('Invalid embedding response.');
      const values =
        'embeddings' in raw
          ? raw.embeddings
          : 'data' in raw && Array.isArray(raw.data)
            ? raw.data.map((entry: unknown, index: number) => {
                if (
                  !entry ||
                  typeof entry !== 'object' ||
                  !('index' in entry) ||
                  entry.index !== index ||
                  !('embedding' in entry)
                )
                  throw new Error('Invalid embedding ordering.');
                return entry.embedding;
              })
            : null;
      if (!Array.isArray(values) || values.length !== input.length)
        throw new Error('Embedding count mismatch.');
      let dimensions = 0;
      return values.map((value: unknown) => {
        if (
          !Array.isArray(value) ||
          !value.length ||
          value.length > 8192 ||
          value.some((x: unknown) => typeof x !== 'number' || !Number.isFinite(x))
        )
          throw new Error('Invalid embedding vector.');
        const vector = value as number[];
        dimensions ||= vector.length;
        if (vector.length !== dimensions) throw new Error('Embedding dimension mismatch.');
        const norm = Math.hypot(...vector);
        if (!norm || !Number.isFinite(norm)) throw new Error('Invalid embedding norm.');
        return vector.map((x) => x / norm);
      });
    },
  };
};
