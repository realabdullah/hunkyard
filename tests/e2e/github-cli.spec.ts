import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { createGitFixture } from '@reviewlab/testing';
import { fixtureStatePath } from './runtime-path';

const execute = promisify(execFile);
test('CLI PR launch uses gh contract and isolated pinned Git capture without checkout changes', async () => {
  test.skip(
    process.platform === 'win32',
    'POSIX shebang gh/Git shim; provider contracts and packaged CLI smoke run on Windows.',
  );
  const state = JSON.parse(await readFile(fixtureStatePath, 'utf8')) as { configFile: string };
  const config = JSON.parse(await readFile(state.configFile, 'utf8')) as {
    model: Record<string, unknown>;
  };
  const local = await createGitFixture();
  const remote = await createGitFixture();
  const bin = await mkdtemp(join(tmpdir(), 'reviewlab-gh-cli-'));
  try {
    await local.git('remote', 'add', 'origin', 'https://github.com/fixture/reviewlab.git');
    const base = (await remote.git('rev-parse', 'HEAD')).trim();
    await writeFile(
      join(remote.root, 'example.ts'),
      'export const divide = (value: number) => value / 0;\n',
    );
    await remote.git('add', 'example.ts');
    await remote.git('commit', '-m', 'PR fixture');
    const head = (await remote.git('rev-parse', 'HEAD')).trim();
    await remote.git('update-ref', 'refs/pull/12/head', head);
    await writeFile(join(local.root, 'example.ts'), 'export const value = 7;\n');
    await local.git('add', 'example.ts');
    await writeFile(join(local.root, 'example.ts'), 'export const value = 8;\n');
    const index = await local.git('write-tree');
    const refs = await local.git('show-ref');
    const realGit = (await execute('which', ['git'])).stdout.trim();
    const responseFile = join(bin, 'responses.json');
    await writeFile(
      responseFile,
      JSON.stringify({
        [`repos/fixture/reviewlab/pulls/12`]: {
          number: 12,
          title: 'CLI PR fixture',
          body: 'No external publication.',
          html_url: 'https://github.com/fixture/reviewlab/pull/12',
          state: 'open',
          base: { sha: base, repo: { full_name: 'fixture/reviewlab' } },
          head: { sha: head },
        },
        [`repos/fixture/reviewlab/compare/${base}...${head}`]: { merge_base_commit: { sha: base } },
        [`repos/fixture/reviewlab/commits/${head}/check-runs?per_page=100&page=1`]: {
          total_count: 0,
          check_runs: [],
        },
      }),
    );
    await writeFile(
      join(bin, 'gh'),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'api' || args[args.indexOf('--hostname') + 1] !== 'github.com' || args[args.indexOf('--method') + 1] !== 'GET') process.exit(2);
const endpoint = args.find((arg) => arg.startsWith('repos/'));
const data = JSON.parse(fs.readFileSync(${JSON.stringify(responseFile)}, 'utf8'))[endpoint] ?? [];
process.stdout.write('HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n' + JSON.stringify(data));
`,
      { mode: 0o700 },
    );
    await writeFile(
      join(bin, 'git'),
      `#!${process.execPath}
const { spawnSync } = require('node:child_process');
let args = process.argv.slice(2);
if (args.includes('fetch')) {
  const index = args.indexOf('https://github.com/fixture/reviewlab.git');
  if (index < 0) process.exit(2);
  args[index] = ${JSON.stringify(remote.root)};
  args = ['-c', 'protocol.file.allow=always', ...args];
}
const child = spawnSync(${JSON.stringify(realGit)}, args, { env: process.env, stdio: 'inherit' });
process.exit(child.status ?? 1);
`,
      { mode: 0o700 },
    );
    const configPath = join(bin, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        model: { ...config.model, provider: 'ollama', model: 'fixture', privacy: 'cloud-allowed' },
        rules: [],
        cloudConsent: {},
      }),
    );
    const env = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      REVIEWLAB_USER_CONFIG: configPath,
    };
    const args = [
      'exec',
      'tsx',
      'apps/cli/src/index.ts',
      'pr',
      'review',
      '12',
      '--repo',
      local.root,
      '--allow-github',
      '--json',
    ];
    const result = await execute(process.execPath, [process.env.npm_execpath ?? '', ...args], {
      env,
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const session = JSON.parse(result.stdout) as {
      status: string;
      snapshot: { pullRequest: { headSha: string }; diff: string };
    };
    expect(session.status).toBe('completed');
    expect(session.snapshot.pullRequest.headSha).toBe(head);
    expect(session.snapshot.diff).toContain('value / 0');
    expect(await local.git('write-tree')).toBe(index);
    expect(await local.git('show-ref')).toBe(refs);
    expect(await readFile(join(local.root, 'example.ts'), 'utf8')).toContain('value = 8');
    const denied = await execute(
      process.execPath,
      [process.env.npm_execpath ?? '', ...args.filter((arg) => arg !== '--allow-github')],
      { env, timeout: 30000 },
    ).then(
      () => '',
      (error: { stderr: string }) => error.stderr,
    );
    expect(denied).toContain('requires explicit --allow-github');
  } finally {
    await local.dispose();
    await remote.dispose();
    await rm(bin, { recursive: true, force: true });
  }
});
