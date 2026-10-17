import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCorrectnessReviewer } from '@hunkyard/agents';
import { createReviewService } from '@hunkyard/core';
import {
  type ModelTarget,
  ModelTargetSchema,
  type ReviewOptions,
  ReviewOptionsSchema,
} from '@hunkyard/domain';
import { captureStaged } from '@hunkyard/git';
import { createSqliteSessionStore } from '@hunkyard/storage';
import { createGitFixture } from './git-fixture';
import { benchmarkCases, scriptedReviewer } from './phase-four-fixtures';

export const runQualityBenchmark = async (live?: {
  target: ModelTarget;
  models: string[];
  options: ReviewOptions;
  secret: (target: ModelTarget) => Promise<string | undefined>;
}) => {
  const fixture = await createGitFixture();
  try {
    for (const item of benchmarkCases) {
      await writeFile(join(fixture.root, item.file), `${item.bug}\n`);
      await writeFile(join(fixture.root, `safe-${item.file}`), `${item.safe}\n`);
    }
    await fixture.git('add', '.');
    const snapshot = await captureStaged(fixture.root);
    const bundle = { version: 1 as const, instructions: [], sources: [], exclusions: [] };
    const policy = {
      ...bundle,
      hash: createHash('sha256').update(JSON.stringify(bundle)).digest('hex'),
    };
    const rows: {
      model: string;
      profile: string;
      verify: boolean;
      status: string;
      truePositives: number;
      falsePositives: number;
      recall: number;
      precision: number;
      rawCandidates: number;
      finalFindings: number;
      reservedTokens: number;
      elapsedMs: number;
      error: string | undefined;
    }[] = [];
    for (const model of live?.models ?? ['scripted-precise', 'scripted-noisy']) {
      const target = live
        ? { ...live.target, model }
        : ModelTargetSchema.parse({
            model,
            repository: 'synthetic-benchmark',
            cloudConsent: false,
            maxTokens: 1000,
            maxReviewTokens: 400000,
          });
      const service = createReviewService({
        root: fixture.root,
        store: createSqliteSessionStore(fixture.root),
        captureStaged: async () => snapshot,
        resolvePolicy: async () => policy,
        loadTarget: async () => target,
        loadReviewOptions: async () => ReviewOptionsSchema.parse({}),
        agent: live
          ? createCorrectnessReviewer(undefined, live.secret)
          : scriptedReviewer(model === 'scripted-noisy'),
      });
      for (const profile of ['quick', 'standard', 'deep'] as const)
        for (const verify of [false, true]) {
          const started = performance.now();
          const session = await service.start(
            {},
            { ...live?.options, agentModels: {}, profile, verify },
          );
          await service.execute(session.id);
          const result = await service.get(session.id);
          if (!result) throw new Error('Missing benchmark run.');
          const detected = new Set(
            result.findings
              .filter((finding) =>
                benchmarkCases.some(
                  (item) =>
                    finding.file === item.file && finding.line === 1 && finding.side === 'new',
                ),
              )
              .map((finding) => finding.file),
          );
          const falsePositives = result.findings.filter(
            (finding) =>
              !benchmarkCases.some(
                (item) =>
                  finding.file === item.file && finding.line === 1 && finding.side === 'new',
              ),
          ).length;
          rows.push({
            model,
            profile,
            verify,
            status: result.status,
            truePositives: detected.size,
            falsePositives,
            recall: detected.size / benchmarkCases.length,
            precision: result.findings.length ? detected.size / result.findings.length : 0,
            rawCandidates:
              result.orchestration?.agents
                .filter((entry) => entry.id !== 'verifier')
                .reduce((sum, entry) => sum + entry.findings.length, 0) ?? 0,
            finalFindings: result.findings.length,
            reservedTokens: result.orchestration?.reservedTokens ?? 0,
            error: result.error,
            elapsedMs: Math.round(performance.now() - started),
          });
        }
      await service.shutdown();
    }
    return { synthetic: !live, rows };
  } finally {
    await fixture.dispose();
  }
};

export const benchmarkMarkdown = (report: Awaited<ReturnType<typeof runQualityBenchmark>>) =>
  [
    '# Phase 4 — Comparative benchmark',
    '',
    report.synthetic
      ? '**Synthetic contract run. Scripted responses validate scoring, profile selection, deduplication and verification. These are not measured inference-quality results.**'
      : '**Live model run against synthetic source fixtures. Human adjudication of explanations is still required.**',
    '',
    'Five seeded bugs: nullable dereference, SQL injection, hidden focusable button, polling leak and uncalled assertion. Each has a safe counterpart. Recall uses all five defects as the denominator across profiles. Scores match frozen file/line anchors; explanations need human review before treating this as model quality.',
    '',
    '| Model | Profile | Verify | State | TP | FP | Precision | Recall | Raw → final | Reserved tokens |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.rows.map(
      (row) =>
        `| ${row.model.replaceAll('|', '\\|')} | ${row.profile} | ${row.verify} | ${row.status} | ${row.truePositives} | ${row.falsePositives} | ${row.precision.toFixed(2)} | ${row.recall.toFixed(2)} | ${row.rawCandidates} → ${row.finalFindings} | ${row.reservedTokens} |`,
    ),
    '',
    ...report.rows
      .filter((row) => row.error)
      .map((row) => `- ${row.model}/${row.profile}: ${row.error}`),
    '',
  ].join('\n');
