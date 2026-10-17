import { createHash } from 'node:crypto';
import type { ReviewAgent } from '@reviewlab/core/ports';
import { ReviewOutputSchema, type ReviewSnapshot } from '@reviewlab/domain';

export type ReviewTraceStep = {
  diff: string;
  instructions: string[];
  output: unknown;
};

export type FakeModelRequest = { diff: string; instructions: string[] };
export type FakeModelGateway = { generate: (request: FakeModelRequest) => Promise<unknown> };

/** No network transport; deterministic input matching and raw response replay. */
export const createReplayModelGateway = (steps: readonly ReviewTraceStep[]) => {
  const trace = structuredClone(steps);
  let cursor = 0;
  const gateway: FakeModelGateway = {
    generate: async ({ diff, instructions }) => {
      const step = trace[cursor];
      if (!step) throw new Error('Review trace exhausted.');
      if (
        diff !== step.diff ||
        JSON.stringify(instructions) !== JSON.stringify(step.instructions)
      ) {
        throw new Error(`Review trace input mismatch at step ${cursor}.`);
      }
      cursor += 1;
      return structuredClone(step.output);
    },
  };
  return {
    gateway,
    assertConsumed: () => {
      if (cursor !== trace.length) throw new Error('Review trace has unconsumed steps.');
    },
  };
};

export const createReplayReviewer = (steps: readonly ReviewTraceStep[]) => {
  const replay = createReplayModelGateway(steps);
  const agent: ReviewAgent = {
    review: async ({ snapshot, instructions }) =>
      ReviewOutputSchema.parse(await replay.gateway.generate({ diff: snapshot.diff, instructions }))
        .findings,
  };
  return { ...replay, agent };
};

export const fixtureSnapshot = (diff: string): ReviewSnapshot => ({
  version: 2,
  sources: [],
  id: '00000000-0000-4000-8000-000000000001',
  repoRoot: '/fixture',
  repositoryGitDir: '/fixture/.git',
  scope: 'staged',
  baseTree: 'c'.repeat(40),
  gitVersion: 'git version fixture',
  changes: [],
  diffHash: createHash('sha256').update(diff).digest('hex'),
  headSha: 'a'.repeat(40),
  indexTree: 'b'.repeat(40),
  diff,
  files: ['example.ts'],
  createdAt: '2026-10-14T00:00:00.000Z',
});
