import type { ModelTarget } from '@reviewlab/domain';

type Message = { role: string; content: string };
export const chatBody = (
  target: ModelTarget,
  messages: Message[],
  maxTokens: number,
  schema?: Record<string, unknown>,
): unknown => {
  const mode = schema ? 'schema' : (target.structuredOutput ?? 'json');
  if (target.provider === 'deepseek' && mode === 'schema')
    throw new Error('DeepSeek Chat Completions uses JSON mode; select structured-output json.');
  const outputSchema = schema ?? {
    type: 'object',
    additionalProperties: false,
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'file',
            'line',
            'side',
            'severity',
            'title',
            'explanation',
            'evidence',
            'recommendation',
            'confidence',
          ],
          properties: {
            file: { type: 'string' },
            line: { type: 'integer', minimum: 1 },
            side: { type: 'string', enum: ['old', 'new'] },
            severity: {
              type: 'string',
              enum: ['critical', 'high', 'medium', 'low', 'info', 'major', 'minor'],
            },
            title: { type: 'string' },
            explanation: { type: 'string' },
            evidence: { type: 'string' },
            recommendation: { type: 'string' },
            confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
        },
      },
    },
  };
  if (target.provider === 'ollama')
    return {
      model: target.model,
      messages,
      stream: false,
      ...(mode === 'text' ? {} : { format: mode === 'schema' ? outputSchema : 'json' }),
      options: {
        num_predict: maxTokens,
        temperature: target.temperature ?? 0,
        top_p: target.topP ?? 1,
        ...(target.contextWindow ? { num_ctx: target.contextWindow } : {}),
      },
    };
  return {
    model: target.model,
    messages,
    stream: false,
    ...(target.provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
    ...(target.provider === 'openai'
      ? { store: false, max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens }),
    temperature: target.temperature ?? 0,
    top_p: target.topP ?? 1,
    ...(mode === 'text'
      ? {}
      : {
          response_format:
            mode === 'schema'
              ? {
                  type: 'json_schema',
                  json_schema: { name: 'reviewlab', strict: true, schema: outputSchema },
                }
              : { type: 'json_object' },
        }),
  };
};
