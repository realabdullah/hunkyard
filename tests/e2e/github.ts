import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewServiceDependencies } from '@reviewlab/core/ports';
import type { Publication, PullRequestContext } from '@reviewlab/domain';
import { captureSnapshot } from '@reviewlab/git';
import { createGitFixture } from '@reviewlab/testing';

// Deterministic PR service for the browser journey; no GitHub network or credentials.
export const createGitHubFixture = async (root: string) => {
  const remote = await createGitFixture();
  const base = (await remote.git('rev-parse', 'HEAD')).trim();
  await writeFile(
    join(remote.root, 'example.ts'),
    'export const divide = (value: number) => value / 0;\n',
  );
  await remote.git('add', 'example.ts');
  await remote.git('commit', '-m', 'PR first');
  const first = (await remote.git('rev-parse', 'HEAD')).trim();
  await writeFile(
    join(remote.root, 'example.ts'),
    'export const divide = (value: number) => value / 0;\nexport const revision = 2;\n',
  );
  await remote.git('add', 'example.ts');
  await remote.git('commit', '-m', 'PR second');
  const second = (await remote.git('rev-parse', 'HEAD')).trim();
  await remote.git('update-ref', 'refs/heads/main', first);
  const posted: Publication[] = [];
  const head = async () => ({
    headSha: (await remote.git('rev-parse', 'refs/heads/main')).trim(),
    baseSha: base,
    state: 'open',
  });
  const adapter: NonNullable<ReviewServiceDependencies['github']> = {
    repository: async () => 'fixture/reviewlab',
    head,
    capture: async (request, exclusions) => {
      const current = await head();
      const context: PullRequestContext = {
        repository: request.repository,
        number: request.number,
        url: `https://github.com/fixture/reviewlab/pull/${request.number}`,
        title: 'Browser PR fixture',
        body: 'A saved PR with mandatory external review.',
        state: 'open',
        baseSha: base,
        headSha: current.headSha,
        mergeBaseSha: base,
        fetchedAt: new Date().toISOString(),
        comments: [
          {
            id: 17,
            kind: 'inline',
            author: 'qodo-code-review[bot]',
            body: 'Qodo context: inspect denominator. Organizational review remains required.',
            url: 'https://github.com/fixture/reviewlab/pull/12#discussion_r17',
            path: 'example.ts',
            line: current.headSha === first ? 1 : null,
            side: 'RIGHT',
            commitSha: first,
            outdated: current.headSha !== first,
          },
        ],
        checks: [
          { name: 'Qodo external review', state: 'completed', conclusion: 'neutral', url: null },
        ],
        diagnostics: [],
      };
      const snapshot = await captureSnapshot(
        remote.root,
        { kind: 'commit-range', from: base, to: current.headSha },
        exclusions,
      );
      return {
        ...snapshot,
        repoRoot: root,
        repositoryGitDir: join(root, '.git'),
        baseSha: base,
        comparisonSha: base,
        pullRequest: context,
      };
    },
    findPublication: async (entry) => posted.find((posted) => posted.id === entry.id)?.url,
    publish: async (entry) => {
      const url = `https://github.com/fixture/reviewlab/pull/12#issuecomment-${posted.length + 1}`;
      posted.push({ ...entry, url });
      return url;
    },
  };
  return { adapter, root: remote.root, first, second, dispose: remote.dispose };
};
