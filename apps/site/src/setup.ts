import { $, $$ } from './dom';

// Endpoints and models mirror providerDefaults in packages/domain/src/providers.ts.
const local = (provider: string, endpoint: string, runtime: string) => ({
  command: `hunkyard config --provider ${provider} --endpoint ${endpoint} --model qwen2.5-coder:7b --privacy local-only`,
  note: `Use a model you have in ${runtime}. Local-only mode blocks every other destination.`,
});
const hosted = (provider: string, model: string, key: string) => ({
  command: `hunkyard config --provider ${provider} --model ${model} --privacy cloud-allowed --allow-cloud`,
  note: `Set ${key} in your environment first. Consent covers this repository only; revoke it with hunkyard config --revoke-cloud.`,
});

const providers: Record<string, { command: string; note: string }> = {
  ollama: local('ollama', 'http://127.0.0.1:11434', 'Ollama'),
  'lm-studio': local('lm-studio', 'http://127.0.0.1:1234/v1', 'LM Studio'),
  'llama-cpp': local('llama-cpp', 'http://127.0.0.1:8080/v1', 'your llama.cpp server'),
  compatible: local('compatible', 'http://127.0.0.1:8080/v1', 'your server'),
  openai: hosted('openai', 'gpt-4.1-mini', 'OPENAI_API_KEY'),
  deepseek: hosted('deepseek', 'deepseek-flash', 'DEEPSEEK_API_KEY'),
};

/** The install step's provider picker: one radio group that swaps the config command. */
export const initSetup = () => {
  const options = $$<HTMLButtonElement>('[data-provider]');
  const choose = (provider: string, focus = false) => {
    const setup = providers[provider];
    if (!setup) return;
    for (const option of options) {
      const on = option.dataset.provider === provider;
      option.setAttribute('aria-checked', String(on));
      option.tabIndex = on ? 0 : -1;
      if (on && focus) option.focus();
    }
    $('#setup-cmd').textContent = setup.command;
    $('#setup-copy').dataset.copy = setup.command;
    $('#setup-note').textContent = setup.note;
  };

  $('#providers').addEventListener('click', (event) => {
    const provider = (event.target as Element).closest<HTMLElement>('[data-provider]')?.dataset
      .provider;
    if (provider) choose(provider);
  });
  $('#providers').addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    const index = options.findIndex((option) => option.getAttribute('aria-checked') === 'true');
    const next = options[(index + step + options.length) % options.length];
    if (next?.dataset.provider) choose(next.dataset.provider, true);
  });

  choose('ollama');
};
