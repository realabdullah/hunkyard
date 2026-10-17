import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createGitFixture } from '../packages/testing/src/git-fixture';

const execute = promisify(execFile);
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run through pnpm smoke:release.');
const temporary = await mkdtemp(join(tmpdir(), 'hunkyard-release-'));
const fixture = await createGitFixture();
try {
  const config = join(temporary, 'config.json');
  const env: NodeJS.ProcessEnv = { ...process.env, HUNKYARD_USER_CONFIG: config };
  delete env.HUNKYARD_REPO;
  await writeFile(join(temporary, 'package.json'), '{"private":true}');
  await execute(process.execPath, [
    pnpm,
    '--dir',
    resolve('dist/release'),
    'pack',
    '--pack-destination',
    temporary,
  ]);
  const archive = (await readdir(temporary)).find((file) => file.endsWith('.tgz'));
  if (!archive) throw new Error('Tarball missing.');
  await execute(
    process.execPath,
    [pnpm, '--dir', temporary, 'add', join(temporary, archive), '--offline', '--ignore-scripts'],
    { env, timeout: 30000 },
  );
  const installed = join(temporary, 'node_modules/@hunkyard/cli');
  const cli = join(installed, 'cli.mjs');
  const run = (...args: string[]) =>
    execute(process.execPath, [cli, ...args, '--repo', fixture.root], { env, timeout: 30000 });
  assert.match((await run('--help')).stdout, /Hunkyard/);
  assert.match(await readFile(join(installed, 'README.md'), 'utf8'), /# Hunkyard/);
  assert.equal(
    JSON.parse(
      (
        await run(
          'policy-lint',
          '--file',
          join(installed, 'examples/plugins/resource-lifetime.json'),
        )
      ).stdout,
    ).valid,
    true,
  );
  assert.equal(
    JSON.parse(
      (await run('policy-inspect', '--file', join(installed, 'examples/policies/team-review.json')))
        .stdout,
    ).version,
    1,
  );
  const standalonePolicy = await execute(
    process.execPath,
    [cli, 'policy-inspect', '--file', join(installed, 'examples/policies/team-review.json')],
    { env, cwd: temporary },
  );
  assert.equal(JSON.parse(standalonePolicy.stdout).version, 1);
  assert.match(JSON.parse((await run('plan')).stdout).fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse((await run('analytics')).stdout).runs, 0);
  assert.equal(JSON.parse((await run('doctor', '--no-probe')).stdout).ok, true);
  await run('config', '--privacy', 'local-only');
  assert.equal(JSON.parse(await readFile(config, 'utf8')).version, 1);
  assert.deepEqual(JSON.parse((await run('sessions', '--json')).stdout), []);
  await run('backup', '--file', join(temporary, 'history.db'));
  await rm(join(fixture.root, '.hunkyard/sqlite'), { recursive: true });
  assert.equal(
    JSON.parse((await run('restore', '--file', join(temporary, 'history.db'))).stdout).restored,
    0,
  );
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No port.');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const nested = join(fixture.root, 'nested', 'directory');
  await mkdir(nested, { recursive: true });
  // Exercise the installed command and cwd discovery without an explicit subcommand/repo.
  const child = spawn(
    process.platform === 'win32' ? process.execPath : join(temporary, 'node_modules/.bin/hunkyard'),
    [...(process.platform === 'win32' ? [cli] : []), '--no-browser', '--port', String(port)],
    { env, cwd: nested },
  );
  let output = '';
  let errors = '';
  child.stdout.on('data', (data) => {
    output += String(data);
  });
  child.stderr.on('data', (data) => {
    errors += String(data);
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    const deadline = Date.now() + 15000;
    while (
      !output.includes('API connection token') &&
      Date.now() < deadline &&
      child.exitCode === null
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(output, /API connection token/, errors);
    const origin = `http://127.0.0.1:${port}`;
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    const html = await page.text();
    const asset = html.match(/src="([^"]+\.js)"/)?.[1];
    assert.ok(asset, 'Packaged UI entrypoint is missing.');
    assert.equal((await fetch(new URL(asset, origin))).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/sessions`)).status, 401);
    assert.deepEqual(
      JSON.parse(
        (await execute(process.execPath, [cli, 'sessions', '--json'], { env, cwd: nested })).stdout,
      ),
      [],
    );
    await assert.rejects(
      execute(process.execPath, [cli, '--no-browser', '--port', String(port)], {
        env,
        cwd: temporary,
      }),
      /not a git repository/i,
    );
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
  console.log(
    `Release tarball installed offline and CLI default launch/cwd discovery/config/history/static-UI/auth smoke passed: ${process.platform}/${process.arch}, ${process.version}.`,
  );
} finally {
  await fixture.dispose();
  await rm(temporary, { recursive: true, force: true });
}
