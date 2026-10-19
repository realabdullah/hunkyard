import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createGitFixture } from '@hunkyard/testing';
import { expect, test } from '@playwright/test';
import { fixtureStatePath } from './runtime-path';

const execute = promisify(execFile);
const runtime = async () => {
  await expect
    .poll(async () => {
      try {
        await readFile(fixtureStatePath, 'utf8');
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);
  return JSON.parse(await readFile(fixtureStatePath, 'utf8')) as {
    token: string;
    root: string;
    configFile: string;
  };
};

test('CLI doctor, staged review, sessions and help run against the same disposable repository', async () => {
  const shared = await runtime();
  const isolated = await createGitFixture();
  await writeFile(
    join(isolated.root, 'example.ts'),
    'export const divide = (value: number) => value / 0;\n',
  );
  await isolated.git('add', 'example.ts');
  const fixture = { ...shared, root: isolated.root };
  const run = (...args: string[]) =>
    execute(
      process.execPath,
      ['--import', 'tsx', 'apps/cli/src/index.ts', ...args, '--repo', fixture.root],
      { env: { ...process.env, HUNKYARD_USER_CONFIG: fixture.configFile }, timeout: 15_000 },
    );
  try {
    await run('config', '--model', 'fixture');
    const doctor = await run('doctor');
    expect(JSON.parse(doctor.stdout).ok).toBe(true);
    const review = await run('review', '--staged', '--json');
    expect(JSON.parse(review.stdout).status).toBe('completed');
    const sessions = await run('sessions', '--json');
    expect(JSON.parse(sessions.stdout).length).toBeGreaterThan(0);
    const help = await run('open', '--help');
    expect(help.stdout).toContain('review --staged');
  } finally {
    await isolated.dispose();
  }
});
