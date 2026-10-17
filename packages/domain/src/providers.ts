import { z } from 'zod';

export const ProviderSchema = z.enum([
  'ollama',
  'openai',
  'deepseek',
  'agentrouter',
  'lm-studio',
  'llama-cpp',
  'compatible',
]);
export type Provider = z.infer<typeof ProviderSchema>;
export const providerDefaults: Record<Provider, { endpoint: string; model: string }> = {
  ollama: { endpoint: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b' },
  openai: { endpoint: 'https://api.openai.com', model: 'gpt-4.1-mini' },
  deepseek: { endpoint: 'https://api.deepseek.com', model: 'deepseek-flash' },
  agentrouter: { endpoint: 'https://co.agentrouter.org/v1', model: '' },
  'lm-studio': { endpoint: 'http://127.0.0.1:1234/v1', model: 'qwen2.5-coder:7b' },
  'llama-cpp': { endpoint: 'http://127.0.0.1:8080/v1', model: 'qwen2.5-coder:7b' },
  compatible: { endpoint: 'http://127.0.0.1:8080/v1', model: 'qwen2.5-coder:7b' },
};
export const hostedProviderOrigins: Partial<Record<Provider, readonly string[]>> = {
  openai: ['https://api.openai.com'],
  deepseek: ['https://api.deepseek.com'],
  agentrouter: ['https://agentrouter.org', 'https://co.agentrouter.org'],
};
export const isHostedProvider = (provider: Provider) =>
  hostedProviderOrigins[provider] !== undefined;
