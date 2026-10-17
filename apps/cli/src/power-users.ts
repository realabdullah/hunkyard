import { createHash } from 'node:crypto';
import { readJson } from '@reviewlab/context';
import { effectivenessAnalytics, recommendPresets } from '@reviewlab/core';
import { BenchmarkReportSchema, ShareablePolicySchema } from '@reviewlab/domain';
import type { createRuntime } from '@reviewlab/server/runtime';

type Runtime = Awaited<ReturnType<typeof createRuntime>>;
export const planFingerprint = (plan: unknown) =>
  createHash('sha256').update(JSON.stringify(plan)).digest('hex');

export const handlePowerUserFileCommand = async (command: string, file: string | undefined) => {
  if (['policy-inspect', 'presets'].includes(command)) {
    if (!file) throw new Error('--file PATH is required.');
    const result =
      command === 'presets'
        ? recommendPresets(BenchmarkReportSchema.parse(await readJson(file)))
        : ShareablePolicySchema.parse(await readJson(file));
    console.log(JSON.stringify(result, null, 2));
    return true;
  }
  return false;
};

export const powerUserRuntimeOptions = async (args: string[], command: string) => {
  const has = (flag: string) => args.includes(flag);
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  if (
    [
      '--policy',
      '--allow-policy',
      '--semantic-model',
      '--semantic-endpoint',
      '--allow-local-embeddings',
    ].some(has) &&
    command !== 'review'
  )
    throw new Error('Power-user grants apply to a new review only. Omit flags to disable.');
  if (has('--policy') !== has('--allow-policy'))
    throw new Error('Select --policy PATH and acknowledge --allow-policy after policy-inspect.');
  if (
    has('--semantic-model') !== has('--allow-local-embeddings') ||
    (has('--semantic-endpoint') && !has('--semantic-model'))
  )
    throw new Error(
      'Local semantic retrieval requires --semantic-model NAME --allow-local-embeddings.',
    );
  if (has('--semantic-model'))
    console.error(
      `Local embedding permission: redacted frozen source excerpts go to Ollama ${value('--semantic-model')} at ${value('--semantic-endpoint') ?? 'http://127.0.0.1:11434'}. Vectors stay in memory; no remote fallback. Final context still follows the review model destinations. Omit semantic flags to disable.`,
    );
  if (has('--policy'))
    console.error(
      `Shared policy permission: apply rules, exclusions and review settings from ${value('--policy')} for this run only. Provider/privacy permissions remain in user configuration.`,
    );
  return {
    ...(value('--policy')
      ? {
          sharedPolicy: {
            policy: ShareablePolicySchema.parse(await readJson(value('--policy') ?? '')),
            granted: has('--allow-policy'),
          },
        }
      : {}),
    ...(value('--semantic-model')
      ? {
          semantic: {
            model: value('--semantic-model') ?? '',
            endpoint: value('--semantic-endpoint') ?? 'http://127.0.0.1:11434',
            provider: 'ollama' as const,
            granted: has('--allow-local-embeddings'),
          },
        }
      : {}),
  } satisfies NonNullable<Parameters<typeof createRuntime>[1]>;
};

export const handlePowerUserReadCommand = async (command: string, runtime: Runtime) => {
  if (command === 'plan') {
    const plan = await runtime.service.plan();
    console.log(JSON.stringify({ plan, fingerprint: planFingerprint(plan) }, null, 2));
    return true;
  }
  if (command === 'analytics') {
    console.error(
      'Reads local review history and explicit user dispositions; outputs aggregate model/agent counts locally. No telemetry is sent.',
    );
    const items = [];
    for (const session of await runtime.service.list())
      items.push({
        runs: await runtime.store.runs(session.id),
        interaction: await runtime.store.interaction(session.id),
      });
    console.log(JSON.stringify(effectivenessAnalytics(items), null, 2));
    return true;
  }
  return false;
};
