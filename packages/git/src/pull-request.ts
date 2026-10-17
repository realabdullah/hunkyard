import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CaptureRequestSchema,
  type PullRequestContext,
  PullRequestContextSchema,
  type ReviewSnapshot,
} from '@hunkyard/domain';
import { type GitRunner, git } from './commands';
import { snapshotTrees } from './snapshot';

export const githubRepository = async (root: string): Promise<string> => {
  const remote = (await git(root, 'remote', 'get-url', 'origin')).trim();
  const match = remote.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/,
  );
  if (!match?.[1]) throw new Error('PR review requires an origin on github.com (HTTPS or SSH).');
  return match[1];
};
// No developer Git config, templates, hooks, ref updates, checkout or index use.
const isolatedGit: GitRunner = (cwd, ...args) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'gc.auto=0',
        '-c',
        'maintenance.auto=false',
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.https.allow=always',
        '-c',
        'http.followRedirects=false',
        '-c',
        'credential.helper=',
        '-c',
        'credential.helper=!gh auth git-credential',
        ...args,
      ],
      {
        cwd,
        timeout: 60000,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
          ),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_LAZY_FETCH: '1',
          GH_HOST: 'github.com',
          GH_PROMPT_DISABLED: '1',
          GH_DEBUG: '',
        },
      },
      (error, stdout) =>
        error
          ? reject(
              new Error(
                'Isolated PR Git capture failed or timed out. Check gh authentication and repository access; developer files/index were not changed.',
              ),
            )
          : resolve(stdout),
    );
  });
export const capturePullRequest = async (
  root: string,
  input: PullRequestContext,
  exclusions: string[] = [],
  run: GitRunner = isolatedGit,
  authorize: () => Promise<void> = async () => {},
): Promise<ReviewSnapshot> => {
  const context = PullRequestContextSchema.parse(input);
  if ((await githubRepository(root)).toLowerCase() !== context.repository.toLowerCase())
    throw new Error('PR repository does not match this checkout origin.');
  const dir = await mkdtemp(join(tmpdir(), 'hunkyard-pr-'));
  try {
    await run(dir, 'init', '--bare', '--template=', '.');
    const remote = `https://github.com/${context.repository}.git`;
    await authorize();
    await run(
      dir,
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      '--depth=1',
      remote,
      context.mergeBaseSha,
    );
    await authorize();
    await run(
      dir,
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      '--depth=1',
      remote,
      `refs/pull/${context.number}/head`,
    );
    const head = (await run(dir, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}')).trim();
    if (head !== context.headSha) throw new Error('PR head changed while fetching. Retry capture.');
    const snapshot = await snapshotTrees(
      run,
      dir,
      head,
      (await run(dir, 'rev-parse', `${context.mergeBaseSha}^{tree}`)).trim(),
      (await run(dir, 'rev-parse', `${head}^{tree}`)).trim(),
      CaptureRequestSchema.parse({ kind: 'commit-range', from: context.mergeBaseSha, to: head }),
      exclusions,
    );
    return {
      ...snapshot,
      repoRoot: root,
      repositoryGitDir: (
        await git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')
      ).trim(),
      baseSha: context.mergeBaseSha,
      comparisonSha: context.baseSha,
      pullRequest: context,
      diagnostics: [
        ...(snapshot.diagnostics ?? []),
        'GitHub PR: isolated capture; no developer ref, index or working file changed. Related repository navigation is unavailable after temporary capture cleanup.',
      ],
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
