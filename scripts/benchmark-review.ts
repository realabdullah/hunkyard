import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadAuthorizedProviderSecret, loadReviewOptions, loadTarget } from '@reviewlab/context';
import {
  benchmarkMarkdown,
  runQualityBenchmark,
} from '../packages/testing/src/phase-four-benchmark';

const args = process.argv.slice(2);
if (
  args.some(
    (arg) => arg.startsWith('--') && !['--live', '--model', '--output', '--json'].includes(arg),
  )
)
  throw new Error('Usage: pnpm benchmark [--live --model NAME (repeatable)] [--output PATH]');
const models = args.flatMap((arg, index) => (arg === '--model' ? [args[index + 1] ?? ''] : []));
if (models.some((model) => !model || model.startsWith('--')))
  throw new Error('Missing model name.');
const root = process.cwd();
const target = args.includes('--live') ? await loadTarget(root) : undefined;
if (target)
  console.error(
    `Live benchmark sends seeded fixture source to ${target.provider} at ${target.endpoint}. Uses existing repository consent and secrets.`,
  );
const outputIndex = args.indexOf('--output');
const destination = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
if (outputIndex >= 0 && (!destination || destination.startsWith('--')))
  throw new Error('Missing output path.');
const report = await runQualityBenchmark(
  target
    ? {
        target,
        options: await loadReviewOptions(root),
        models: models.length ? models : [target.model],
        secret: (route) => loadAuthorizedProviderSecret(root, route),
      }
    : undefined,
);
const markdown = args.includes('--json')
  ? `${JSON.stringify(report, null, 2)}\n`
  : benchmarkMarkdown(report);
if (destination) await writeFile(resolve(destination), markdown);
else console.log(markdown);
if (report.rows.some((row) => row.status !== 'completed')) process.exitCode = 1;
