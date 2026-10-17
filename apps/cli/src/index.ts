import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { probeModel, validateTarget } from '@hunkyard/agents';
import {
  configPath,
  loadAuthorizedProviderSecret,
  loadTarget,
  readJson,
  saveProviderSecret,
  updateConfig,
} from '@hunkyard/context';
import {
  CaptureRequestSchema,
  ModelConfigSchema,
  PluginManifestSchema,
  ProviderSchema,
  parsePullRequest,
  providerDefaults,
  RetentionRequestSchema,
  RevisionRequestSchema,
} from '@hunkyard/domain';
import { getRepoRoot } from '@hunkyard/git';
import { createRuntime, startServer } from '@hunkyard/server/runtime';
import { backupHistory, migrateFileHistory, restoreHistory } from '@hunkyard/storage';

import {
  handlePowerUserFileCommand,
  handlePowerUserReadCommand,
  planFingerprint,
  powerUserRuntimeOptions,
} from './power-users';
import { reviewOptionsFromArgs } from './review-options';

const inputArgs = process.argv.slice(2);
const args = !inputArgs[0] || inputArgs[0].startsWith('-') ? ['open', ...inputArgs] : inputArgs;
const command = args[0] === 'pr' && args[1] === 'review' ? 'review' : (args[0] ?? 'open');
if (args[0] === 'pr' && args[1] === 'review') {
  const input = args[2];
  if (!input) throw new Error('Usage: hunkyard pr review NUMBER_OR_URL --allow-github');
  args.splice(1, 2, '--pr', input);
}
const has = (flag: string) => args.includes(flag);
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const help = `Hunkyard — read-only Git reviews\n\nUsage: hunkyard [command] [options]\nRun hunkyard inside a Git repository to open its browser workspace. Subfolders are detected automatically; --repo PATH overrides the repository. No review starts until requested.\n\nPower users: plan (destination preview/fingerprint) | analytics | policy-inspect --file POLICY | presets --file BENCHMARK_JSON\nReview opt-ins: --policy POLICY --allow-policy | --semantic-model NAME --allow-local-embeddings [--semantic-endpoint LOOPBACK_URL]\nWorkflow: --review-options JSON accepts workflow version 1 (read-only specialist DAG). Omit workflow to disable.\nCommands: backup --file PATH, restore --file PATH, policy-lint --file MANIFEST, doctor, review --staged, sessions, open, config, migrate-history, rerun, export, delete, retain, storage\nGitHub: pr review NUMBER_OR_URL --allow-github | review --pr URL --allow-github (requires cloud-allowed privacy and gh auth login)\nPR refresh: rerun --session UUID --revision N --recapture --allow-github\nScopes: --staged | --unstaged | --working-tree | --branch REF | --from REF --to REF\n        --include-untracked (local scopes), --path GLOB (repeatable), --rename-threshold 1–100\nOptions: --repo PATH, --json, --no-browser (open), --port PORT (open), --no-probe (doctor)\nPlugins: review --plugin MANIFEST (grants snapshot read); --allow-plugin-context grants frozen context\nReview: --profile quick|standard|deep --verify --agent-model AGENT=MODEL (repeatable)\n        --agent-concurrency N --retries 0–2 --priority interactive|background\n        --token-budget N --max-cost-usd N --review-options JSON (routes/prices and advanced options)\nConfig: --provider ollama|openai|deepseek|agentrouter|lm-studio|llama-cpp|compatible --endpoint URL --model NAME --privacy local-only|cloud-allowed\n        --allow-cloud or --revoke-cloud (consent for selected diff, related source context and rules)\nHistory: --session UUID --revision N (rerun/delete), --recapture (rerun), --include-source (export)\nRetention: --before ISO_DATE --keep-latest N\nBudgets: --max-tokens N --max-review-tokens N --context-window N --max-concurrency N\nSampling: --temperature N --top-p N --structured-output json|schema|text\nKeys: config --store-key reads stdin; --clear-key removes stored key. OPENAI_API_KEY, DEEPSEEK_API_KEY and AGENTROUTER_API_KEY override their respective provider storage. No automatic cloud fallback.\n`;
const main = async () => {
  if (has('--help')) {
    console.log(help);
    return;
  }
  const allowed = new Set([
    '--allow-policy',
    '--allow-local-embeddings',
    '--expected-plan',
    '--file',
    '--policy',
    '--semantic-model',
    '--semantic-endpoint',
    '--plugin',
    '--allow-plugin-context',
    '--pr',
    '--allow-github',
    '--profile',
    '--agent-model',
    '--agent-concurrency',
    '--retries',
    '--priority',
    '--token-budget',
    '--max-cost-usd',
    '--review-options',
    '--verify',
    '--repo',
    '--port',
    '--json',
    '--no-browser',
    '--no-probe',
    '--staged',
    '--unstaged',
    '--working-tree',
    '--include-untracked',
    '--path',
    '--branch',
    '--from',
    '--to',
    '--rename-threshold',
    '--provider',
    '--endpoint',
    '--model',
    '--privacy',
    '--allow-cloud',
    '--revoke-cloud',
    '--session',
    '--revision',
    '--recapture',
    '--include-source',
    '--before',
    '--keep-latest',
    '--temperature',
    '--top-p',
    '--context-window',
    '--max-tokens',
    '--max-review-tokens',
    '--max-concurrency',
    '--structured-output',
    '--store-key',
    '--clear-key',
  ]);
  const valued = new Set([
    '--expected-plan',
    '--file',
    '--policy',
    '--semantic-model',
    '--semantic-endpoint',
    '--plugin',
    '--pr',
    '--profile',
    '--agent-model',
    '--agent-concurrency',
    '--retries',
    '--priority',
    '--token-budget',
    '--max-cost-usd',
    '--review-options',
    '--path',
    '--branch',
    '--from',
    '--to',
    '--rename-threshold',
    '--repo',
    '--port',
    '--provider',
    '--endpoint',
    '--model',
    '--privacy',
    '--session',
    '--revision',
    '--before',
    '--keep-latest',
    '--temperature',
    '--top-p',
    '--context-window',
    '--max-tokens',
    '--max-review-tokens',
    '--max-concurrency',
    '--structured-output',
  ]);
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index] ?? '';
    if (!allowed.has(flag)) throw new Error(`Unknown option: ${flag}`);
    if (valued.has(flag)) {
      if (!args[index + 1] || args[index + 1]?.startsWith('--'))
        throw new Error(`Missing value for ${flag}`);
      index += 1;
    }
  }
  if (await handlePowerUserFileCommand(command, value('--file'))) return;
  const root = await getRepoRoot(value('--repo') || process.env.HUNKYARD_REPO || process.cwd());
  const advanced = await powerUserRuntimeOptions(args, command);
  if (['backup', 'restore', 'policy-lint'].includes(command)) {
    const file = value('--file');
    if (!file) throw new Error('--file PATH is required.');
    const result =
      command === 'backup'
        ? await backupHistory(root, file)
        : command === 'restore'
          ? await restoreHistory(root, file)
          : { valid: true, manifest: PluginManifestSchema.parse(await readJson(file)) };
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (has('--plugin') && command !== 'review')
    throw new Error(
      'Declarative plugins are supported by review only. Use an explicit new review for each plugin invocation.',
    );
  if (command === 'config') {
    if (has('--allow-cloud') && has('--revoke-cloud'))
      throw new Error('Choose allow or revoke cloud consent.');
    const target = await loadTarget(root);
    const provider = ProviderSchema.parse(value('--provider') ?? target.provider);
    const model = ModelConfigSchema.parse({
      ...target,
      provider,
      endpoint:
        value('--endpoint') ??
        (provider !== target.provider ? providerDefaults[provider].endpoint : target.endpoint),
      model:
        value('--model') ??
        (provider !== target.provider ? providerDefaults[provider].model : target.model),
      privacy: value('--privacy') ?? target.privacy,
      ...Object.fromEntries(
        [
          ['temperature', '--temperature'],
          ['topP', '--top-p'],
          ['contextWindow', '--context-window'],
          ['maxTokens', '--max-tokens'],
          ['maxReviewTokens', '--max-review-tokens'],
          ['maxConcurrency', '--max-concurrency'],
        ]
          .filter((entry) => entry[1] && value(entry[1]) !== undefined)
          .map(([key, flag]) => [key, Number(value(flag ?? ''))]),
      ),
      ...(value('--structured-output') ? { structuredOutput: value('--structured-output') } : {}),
    });
    if (has('--store-key') && has('--clear-key'))
      throw new Error('Choose store or clear provider key.');
    if (has('--store-key') || has('--clear-key')) {
      if (has('--store-key') && process.stdin.isTTY)
        throw new Error(
          'Provide the provider key through stdin; do not pass it in command arguments.',
        );
      let key: string | null = null;
      if (has('--store-key')) {
        let input = '';
        for await (const chunk of process.stdin) {
          input += String(chunk);
          if (input.length > 4096) throw new Error('Provider key exceeds 4096 characters.');
        }
        key = input.trim();
      }
      await saveProviderSecret(root, model.provider, key);
      console.log(JSON.stringify({ provider: model.provider, stored: key !== null }));
      return;
    }
    const changing = [
      '--provider',
      '--endpoint',
      '--model',
      '--privacy',
      '--allow-cloud',
      '--revoke-cloud',
      '--temperature',
      '--top-p',
      '--context-window',
      '--max-tokens',
      '--max-review-tokens',
      '--max-concurrency',
      '--structured-output',
    ].some(has);
    const result = changing
      ? await updateConfig(root, {
          model,
          ...(has('--allow-cloud')
            ? { allowCloud: true }
            : has('--revoke-cloud')
              ? { allowCloud: false }
              : {}),
        })
      : target;
    console.log(JSON.stringify({ configFile: configPath(), target: result }, null, 2));
    return;
  }
  if (command === 'migrate-history') {
    const result = await migrateFileHistory(root);
    console.log(
      JSON.stringify(
        {
          ...result,
          destination: join(root, '.hunkyard', 'sqlite', 'history.db'),
          originalsPreserved: true,
        },
        null,
        2,
      ),
    );
    return;
  }
  const runtime = [
    'plan',
    'sessions',
    'analytics',
    'doctor',
    'storage',
    'export',
    'review',
    'rerun',
    'delete',
    'retain',
  ].includes(command)
    ? await createRuntime(root, {
        writer: ['review', 'rerun', 'delete', 'retain'].includes(command),
        ...advanced,
        ...(value('--plugin')
          ? {
              plugin: {
                manifest: PluginManifestSchema.parse(await readJson(value('--plugin') ?? '')),
                grants: has('--allow-plugin-context')
                  ? ['snapshot:read', 'context:read']
                  : ['snapshot:read'],
              },
            }
          : {}),
      })
    : null;
  try {
    if (runtime && (await handlePowerUserReadCommand(command, runtime))) return;
    if (command === 'sessions' && runtime) {
      const sessions = await runtime.service.list();
      console.log(
        has('--json')
          ? JSON.stringify(sessions, null, 2)
          : sessions
              .map(
                (s) =>
                  `${s.id}  ${s.status}  ${s.target.provider}/${s.target.model}  ${s.snapshot.files.length} files`,
              )
              .join('\n') || 'No reviews yet.',
      );
      return;
    }
    if (command === 'doctor' && runtime) {
      const target = await loadTarget(root);
      const warnings: string[] = [];
      try {
        await lstat(join(root, '.hunkyard', 'sessions'));
        warnings.push(
          'Legacy sessions remain in .hunkyard/sessions and are not verified or migrated.',
        );
      } catch {
        /* No legacy history. */
      }
      for (const session of await runtime.service.list())
        if (['queued', 'running'].includes(session.status))
          warnings.push(`Interrupted session ${session.id}: cancel it in the workspace.`);
      try {
        validateTarget(target);
        const probe = has('--no-probe')
          ? undefined
          : await probeModel(target, undefined, undefined, (selected) =>
              loadAuthorizedProviderSecret(root, selected),
            );
        console.log(
          JSON.stringify(
            {
              ok: probe ? probe.ready : true,
              root,
              node: process.version,
              target,
              warnings,
              probe,
            },
            null,
            2,
          ),
        );
        if (probe && !probe.ready) process.exitCode = 1;
      } catch (error) {
        console.log(
          JSON.stringify(
            {
              ok: false,
              root,
              target,
              warnings,
              error: error instanceof Error ? error.message : 'Probe failed',
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
      }
      return;
    }
    if (command === 'storage' && runtime) {
      console.log(JSON.stringify(await runtime.service.usage(), null, 2));
      return;
    }
    const selectedId = value('--session');
    if (['export', 'delete', 'rerun'].includes(command) && !selectedId)
      throw new Error('--session UUID is required.');
    if (command === 'export' && runtime && selectedId) {
      if (!(await runtime.service.get(selectedId))) throw new Error('Session not found.');
      console.log(
        JSON.stringify(await runtime.service.export(selectedId, !has('--include-source')), null, 2),
      );
      return;
    }
    if (command === 'delete' && runtime && selectedId) {
      const input = RevisionRequestSchema.parse({ revision: Number(value('--revision')) });
      if (!(await runtime.service.delete(selectedId, input.revision)))
        throw new Error('Session not found.');
      console.log(JSON.stringify({ deleted: true }));
      return;
    }
    if (command === 'retain' && runtime) {
      const options = RetentionRequestSchema.parse({
        before: value('--before'),
        keepLatest: Number(value('--keep-latest')),
      });
      console.log(JSON.stringify({ deleted: await runtime.service.prune(options) }));
      return;
    }
    if ((command === 'review' || command === 'rerun') && runtime) {
      const scopes = [
        '--staged',
        '--unstaged',
        '--working-tree',
        '--branch',
        '--from',
        '--pr',
      ].filter(has);
      if (command === 'review' && scopes.length !== 1)
        throw new Error(
          'Choose exactly one review scope: --staged, --unstaged, --working-tree, --branch REF, --from REF --to REF, or --pr NUMBER_OR_URL.',
        );
      if (has('--pr') && !has('--allow-github'))
        throw new Error('PR capture requires explicit --allow-github consent.');
      if (has('--pr') && ['--path', '--include-untracked', '--rename-threshold', '--to'].some(has))
        throw new Error(
          'PR capture reviews the full PR; local path/untracked/ref options are unsupported.',
        );
      const capture = CaptureRequestSchema.parse({
        kind: has('--unstaged')
          ? 'unstaged'
          : has('--working-tree')
            ? 'working-tree'
            : has('--branch')
              ? 'branch'
              : has('--from')
                ? 'commit-range'
                : 'staged',
        includeUntracked: has('--include-untracked'),
        paths: args.flatMap((arg, index) => (arg === '--path' ? [args[index + 1]] : [])),
        ...(value('--branch') ? { baseRef: value('--branch') } : {}),
        ...(value('--from') ? { from: value('--from'), to: value('--to') } : {}),
        ...(value('--rename-threshold')
          ? { renameThreshold: Number(value('--rename-threshold')) }
          : {}),
      });
      validateTarget(await loadTarget(root));
      const selectedTarget = await loadTarget(root);
      if (!has('--json'))
        console.log(
          `Source destination: ${selectedTarget.provider}/${selectedTarget.model} at ${selectedTarget.endpoint} (${selectedTarget.privacy}).`,
        );
      const defaults =
        (command === 'rerun' && selectedId
          ? (await runtime.service.get(selectedId))?.plan?.options
          : undefined) ?? (await runtime.service.plan()).options;
      const review = reviewOptionsFromArgs(args, defaults);
      if (!has('--json'))
        for (const route of (await runtime.service.plan(review)).agents)
          console.log(
            `${route.id}: ${route.target.provider}/${route.target.model} at ${route.target.endpoint}`,
          );
      if (
        has('--expected-plan') &&
        planFingerprint(await runtime.service.plan(review)) !== value('--expected-plan')
      )
        throw new Error(
          'Review plan changed after consent. Review destinations again before retrying.',
        );
      const session =
        command === 'rerun' && selectedId
          ? await runtime.service.rerun(
              selectedId,
              RevisionRequestSchema.parse({ revision: Number(value('--revision')) }).revision,
              has('--recapture'),
              review,
              undefined,
              has('--allow-github'),
            )
          : has('--pr')
            ? await runtime.service.startPullRequest(
                {
                  ...parsePullRequest(
                    value('--pr') ?? '',
                    await runtime.service.github.repository(),
                  ),
                  allowGitHub: has('--allow-github'),
                },
                review,
              )
            : await runtime.service.start(capture, review);
      if (!session) throw new Error('Session not found.');
      if (has('--expected-plan') && planFingerprint(session.plan) !== value('--expected-plan')) {
        await runtime.service.cancel(session.id);
        throw new Error(
          'Review plan changed after consent. Review destinations again before retrying.',
        );
      }
      const cancel = () => void runtime.service.cancel(session.id);
      process.once('SIGINT', cancel);
      await runtime.service.execute(session.id);
      process.removeListener('SIGINT', cancel);
      const result = await runtime.service.get(session.id);
      console.log(
        has('--json')
          ? JSON.stringify(result, null, 2)
          : [
              `${result?.status}: ${result?.findings.length ?? 0} findings`,
              `Session ${session.id}`,
              result?.error ?? '',
              ...(result?.context?.omissions?.map(
                (entry) => `Omitted ${entry.path}: ${entry.reason}`,
              ) ?? []),
              ...(result?.findings.map(
                (finding) =>
                  `${finding.severity.toUpperCase()} ${finding.file}:${finding.line} (${finding.side}) — ${finding.title}\n${finding.explanation}\nEvidence: ${finding.evidence}\nRecommendation: ${finding.recommendation}`,
              ) ?? []),
            ]
              .filter(Boolean)
              .join('\n\n'),
      );
      if (result?.status === 'failed') process.exitCode = 1;
      if (result?.status === 'cancelled') process.exitCode = 130;
      return;
    }
    if (command === 'open') {
      const port = Number(value('--port') ?? 4317);
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw new Error('Port must be an integer from 1024 to 65535.');
      const server = await startServer(root, port);
      const url = `${server.origin}/#token=${server.token}`;
      if (has('--no-browser')) {
        // Explicit interactive credential delivery; never includes a provider key.
        console.log(
          `Workspace: ${server.origin}\nAPI connection token (this process only): ${server.token}`,
        );
      } else {
        const launcher =
          process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'rundll32'
              : 'xdg-open';
        const launchArgs =
          process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
        try {
          await new Promise<void>((resolve, reject) =>
            execFile(launcher, launchArgs, (error) => (error ? reject(error) : resolve())),
          );
        } catch (error) {
          await server.close();
          throw error;
        }
        console.log(
          `Opened Hunkyard at ${server.origin}. Keep this process running; Ctrl+C stops it.`,
        );
      }
      const stop = async () => {
        await server.close();
        process.exit(0);
      };
      process.once('SIGINT', () => void stop());
      process.once('SIGTERM', () => void stop());
      return;
    }
    throw new Error(`Unknown command: ${command}\n${help}`);
  } finally {
    await runtime?.close();
  }
};
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Hunkyard failed.');
  process.exitCode = 1;
});
