import { createHash } from 'node:crypto';
import type { ReviewSnapshot } from '@hunkyard/domain';

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
