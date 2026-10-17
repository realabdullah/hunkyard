import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export const createGitFixture = async (options: { unborn?: boolean } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'hunkyard-test-'));
  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await execute('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
        ),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Hunkyard Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Hunkyard Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.test',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: 10_000,
    });
    return stdout;
  };
  try {
    await git('init', '--template=', '--initial-branch=main');
    await git('config', 'core.autocrlf', 'false');
    await writeFile(join(root, 'example.ts'), 'export const value = 1;\n');
    await git('add', '--', 'example.ts');
    if (!options.unborn) await git('commit', '-m', 'test: establish baseline');
    return { root, git, dispose: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
};
