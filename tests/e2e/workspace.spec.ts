import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { createGitFixture } from '@reviewlab/testing';
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

test('real staged-review workflow anchors a finding, preserves partial staging and reloads history', async ({
  page,
  request,
}) => {
  const fixture = await runtime();
  const forbidden: string[] = [];
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== 'http://127.0.0.1:5173') {
      forbidden.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  expect((await request.get('http://127.0.0.1:4317/api/v1/sessions')).status()).toBe(401);
  await page.goto(`/#token=${fixture.token}`);
  expect(page.url()).not.toContain('token=');
  await expect(page.getByText('No reviews yet.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Review staged changes' }).click();
  await expect(page.getByRole('heading', { name: 'Division by zero' })).toBeVisible();
  await expect(page.getByText('completed', { exact: true })).toBeVisible();
  await expect(page.locator('.diff')).toContainText('value / 0');
  await expect(page.locator('.diff')).not.toContainText('value / 2');
  await page.getByRole('button', { name: 'example.ts:1 (new)', exact: true }).click();
  await expect(page.locator('[id="new:example.ts:1"]')).toBeFocused();
  await page.getByText('Change finding status', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('dismissed');
  await page.getByRole('button', { name: 'Save finding decision' }).click();
  await expect(page.locator('.finding-meta').getByText('dismissed', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/phase-one-workspace.png', fullPage: true });
  await page.getByText('Snapshot & rule provenance').click();
  await expect(page.getByText('Diff SHA-256', { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Connect to your local workspace' }),
  ).toBeVisible();
  await page.getByLabel('API connection token').fill(fixture.token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Division by zero' })).toBeVisible();
  expect(forbidden).toEqual([]);
});

test('model failure and cancellation are observable through real API/provider requests', async ({
  page,
}) => {
  const fixture = await runtime();
  await page.goto(`/#token=${fixture.token}`);
  await page.getByRole('button', { name: 'Model & privacy', exact: true }).click();
  await page.getByLabel('Model', { exact: true }).fill('broken-fixture');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status')).toContainText('Settings saved');
  await page.getByRole('button', { name: 'Review workspace' }).click();
  await page.getByRole('button', { name: 'Review staged changes' }).click();
  await expect(page.getByRole('alert')).toContainText('after one repair');
  await page.getByRole('button', { name: 'Model & privacy', exact: true }).click();
  await page.getByLabel('Model', { exact: true }).fill('slow-fixture');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status')).toContainText('Settings saved');
  await page.getByRole('button', { name: 'Review workspace' }).click();
  await page.getByRole('button', { name: 'Review staged changes' }).click();
  await page.getByRole('button', { name: 'Cancel review', exact: true }).click();
  await expect(page.getByText('cancelled', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Model & privacy', exact: true }).click();
  await page.getByLabel('Model', { exact: true }).fill('fixture');
  await page.getByRole('button', { name: 'Save settings' }).click();
});

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
      { env: { ...process.env, REVIEWLAB_USER_CONFIG: fixture.configFile }, timeout: 15_000 },
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

test('reviewlab open starts the secured production workspace and shuts down cleanly', async ({
  page,
  request,
}) => {
  const shared = await runtime();
  const isolated = await createGitFixture();
  await writeFile(
    join(isolated.root, 'example.ts'),
    'export const divide = (value: number) => value / 0;\n',
  );
  await isolated.git('add', 'example.ts');
  const fixture = { ...shared, root: isolated.root };
  await execute(
    process.execPath,
    [
      '--import',
      'tsx',
      'apps/cli/src/index.ts',
      'review',
      '--staged',
      '--json',
      '--repo',
      fixture.root,
    ],
    { env: { ...process.env, REVIEWLAB_USER_CONFIG: fixture.configFile } },
  );
  const { spawn } = await import('node:child_process');
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'apps/cli/src/index.ts',
      'open',
      '--repo',
      fixture.root,
      '--no-browser',
      '--port',
      '4318',
    ],
    {
      env: { ...process.env, REVIEWLAB_USER_CONFIG: fixture.configFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  try {
    await expect.poll(() => output.includes('API connection token')).toBe(true);
    const token = output.match(/API connection token \(this process only\): ([a-f0-9]+)/)?.[1];
    if (!token) throw new Error('CLI failed to deliver its API credential');
    expect((await request.get('http://127.0.0.1:4318/api/v1/sessions')).status()).toBe(401);
    await page.goto(`http://127.0.0.1:4318/#token=${token}`);
    await expect(page.getByRole('heading', { name: 'ReviewLab' })).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('margin', '0px');
    await expect(page.getByRole('heading', { name: 'Division by zero' })).toBeVisible();
    await page.getByRole('button', { name: 'example.ts:1 (new)', exact: true }).click();
    await page.getByRole('button', { name: 'Open split/unified code editor' }).click();
    await expect(page.locator('.monaco-diff-editor')).toBeVisible();
    await expect(page.locator('.code-editor')).toContainText('value / 0');
    expect(page.url()).not.toContain('token=');
  } finally {
    child.kill('SIGINT');
    await exited;
    await isolated.dispose();
  }
});

test('durable runs, replayed progress, local export and explicit deletion work in the browser', async ({
  page,
}) => {
  const fixture = await runtime();
  let connections = 0;
  await page.route('**/api/v1/sessions/*/events?*', async (route) => {
    connections += 1;
    if (connections === 1) return route.abort();
    return route.continue();
  });
  await page.goto(`/#token=${fixture.token}`);
  await expect(page.getByText('Live progress connected', { exact: true })).toBeVisible();
  expect(connections).toBeGreaterThan(1);
  await expect(
    page.getByRole('button', { name: 'Review staged changes', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Review staged changes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Division by zero' })).toBeVisible();
  await expect(page.getByText('run completed', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Rerun frozen snapshot', exact: true }).click();
  const selector = page.getByLabel('View run and its frozen snapshot');
  await expect(selector.locator('option')).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: 'Rerun frozen snapshot', exact: true }),
  ).toBeEnabled();
  const previous = await selector.locator('option').nth(1).getAttribute('value');
  if (!previous) throw new Error('Historical run missing');
  await selector.selectOption(previous);
  await expect(page.getByText('Historical run.', { exact: false })).toBeVisible();
  await expect(page.locator('.diff')).toContainText('value / 0');
  await expect(page.getByRole('button', { name: 'Dismiss finding' })).toHaveCount(0);
  await page.getByRole('button', { name: 'example.ts:1 (new)', exact: true }).click();
  await expect(page.locator('[id="new:example.ts:1"]')).toBeFocused();
  await selector.selectOption('');
  await page.getByRole('button', { name: 'Capture staged changes & rerun', exact: true }).click();
  await expect(selector.locator('option')).toHaveCount(3);
  await expect(
    page.getByRole('button', { name: 'Rerun frozen snapshot', exact: true }),
  ).toBeEnabled();
  await page.getByText('Export or delete session', { exact: true }).click();
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download redacted diagnostic export', exact: true })
    .click();
  const artifact = await download;
  const path = await artifact.path();
  if (!path) throw new Error('Export download missing');
  const diagnostic = await readFile(path, 'utf8');
  expect(diagnostic).not.toContain('value / 0');
  expect(diagnostic).not.toContain(fixture.root);
  await page.screenshot({ path: 'test-results/phase-two-workspace.png', fullPage: true });
  await page.getByRole('button', { name: 'Delete session…', exact: true }).click();
  await page.getByRole('button', { name: 'Permanently delete session', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Confirm session deletion' })).toHaveCount(0);
});

test('Phase 3 browser and CLI scopes expose frozen working content, untracked inclusion and omission reasons', async ({
  page,
  request,
}) => {
  const fixture = await runtime();
  const { mkdir, rm } = await import('node:fs/promises');
  const untracked = join(fixture.root, 'scope-untracked.ts');
  await writeFile(untracked, 'export const added = 1;\n');
  await mkdir(join(fixture.root, '.reviewlab'), { recursive: true });
  await writeFile(
    join(fixture.root, '.reviewlab/config.json'),
    JSON.stringify({ exclude: ['scope-untracked.ts'] }),
  );
  const headers = {
    authorization: `Bearer ${fixture.token}`,
    'x-reviewlab-csrf': '1',
    origin: 'http://127.0.0.1:5173',
  };
  try {
    await page.goto(`/#token=${fixture.token}`);
    await page.getByRole('combobox', { name: 'Git scope', exact: true }).selectOption('unstaged');
    await page.getByLabel('Include untracked files', { exact: false }).check();
    await page.getByRole('button', { name: 'Review selected scope', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Frozen unstaged diff', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.diff')).toContainText('value / 2');
    await expect(page.getByText('No actionable findings', { exact: false })).toBeVisible();
    await page.getByText('Scope, instructions & context coverage', { exact: true }).click();
    await expect(page.locator('.context-inspector')).toContainText(
      'scope-untracked.ts: Explicit project exclusion',
    );
    await expect(page.locator('.context-inspector')).toContainText('1/2 changed files included');
    await page.getByRole('combobox', { name: 'Git scope', exact: true }).focus();
    await expect(page.getByRole('combobox', { name: 'Git scope', exact: true })).toBeFocused();
    await page.screenshot({ path: 'test-results/phase-three-workspace.png', fullPage: true });
    const invalid = await request.post('http://127.0.0.1:4317/api/v1/sessions', {
      headers,
      data: { kind: 'branch' },
    });
    expect(invalid.status()).toBe(400);
    await page.getByRole('button', { name: 'Capture unstaged & rerun', exact: true }).click();
    await expect(page.getByLabel('View run and its frozen snapshot').locator('option')).toHaveCount(
      2,
    );
    await expect(
      page.getByRole('button', { name: 'Rerun frozen snapshot', exact: true }),
    ).toBeEnabled();
    await page.getByRole('combobox', { name: 'Git scope', exact: true }).selectOption('branch');
    await page.getByLabel('Base reference', { exact: true }).fill('missing-branch');
    await page.getByRole('button', { name: 'Review selected scope', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Missing or invalid commit');
    const isolated = await createGitFixture();
    try {
      await writeFile(join(isolated.root, 'example.ts'), 'export const working = 1;\n');
      const result = await execute(
        process.execPath,
        [
          '--import',
          'tsx',
          'apps/cli/src/index.ts',
          'review',
          '--working-tree',
          '--json',
          '--repo',
          isolated.root,
        ],
        { env: { ...process.env, REVIEWLAB_USER_CONFIG: fixture.configFile }, timeout: 15000 },
      );
      const run = JSON.parse(result.stdout) as {
        status: string;
        snapshot: { scope: string };
        context: { entries: unknown[] };
      };
      expect(run.status).toBe('completed');
      expect(run.snapshot.scope).toBe('working-tree');
      expect(run.context.entries.length).toBeGreaterThan(0);
    } finally {
      await isolated.dispose();
    }
  } finally {
    await rm(untracked, { force: true });
    await rm(join(fixture.root, '.reviewlab/config.json'), { force: true });
  }
});

test('specialist profile exposes routes, saves deduplicated attribution and verifies immutable candidates', async ({
  page,
  request,
}) => {
  const fixture = await runtime();
  const config = JSON.parse(await readFile(fixture.configFile, 'utf8')) as {
    model: {
      provider: string;
      endpoint: string;
      model: string;
      privacy: string;
      timeoutMs: number;
      maxTokens: number;
    };
  };
  const headers = {
    authorization: `Bearer ${fixture.token}`,
    origin: 'http://127.0.0.1:4317',
    'x-reviewlab-csrf': '1',
  };
  await request.post('http://127.0.0.1:4317/api/v1/config', {
    headers,
    data: {
      model: { ...config.model, model: 'fixture', privacy: 'local-only' },
      allowCloud: false,
    },
  });
  await writeFile(
    join(fixture.root, 'example.ts'),
    'export const divide = (value: number) => value / 0;\n',
  );
  await execute('git', ['add', 'example.ts'], { cwd: fixture.root });
  await page.goto(`/#token=${fixture.token}`);
  await page.getByRole('combobox', { name: 'Review profile', exact: true }).selectOption('deep');
  await page.getByLabel('Independently verify findings').check();
  await page.getByLabel('Agent concurrency', { exact: true }).fill('2');
  await expect(page.getByText('6 reviewers configured', { exact: true })).toBeVisible();
  await page.locator('summary').filter({ hasText: 'security · ollama/fixture' }).click();
  await expect(page.getByLabel('security endpoint', { exact: true })).toHaveValue(
    config.model.endpoint,
  );
  await page.getByLabel('security model', { exact: true }).focus();
  await expect(page.getByLabel('security model', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Review staged changes' }).click();
  await expect(page.getByRole('heading', { name: 'Division by zero' })).toHaveCount(1);
  await expect(page.getByText('completed', { exact: true })).toBeVisible();
  await expect(page.getByText('Independently verified', { exact: false })).toBeVisible();
  await expect(page.getByText('Reviewers:', { exact: false })).toContainText(
    'testing (ollama/fixture)',
  );
  await page.getByText('deep review · agent results and budget', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'verifier · completed' })).toBeVisible();
  await expect(page.getByText('Reserved tokens:', { exact: false })).toContainText('240000');
  await page.getByText('deep review · agent results and budget', { exact: true }).click();
  await page.locator('summary').filter({ hasText: 'security · ollama/fixture' }).click();
  await page.screenshot({ path: 'test-results/phase-four-workspace.png', fullPage: true });
  const cliFixture = await createGitFixture();
  try {
    await writeFile(
      join(cliFixture.root, 'example.ts'),
      'export const divide = (value: number) => value / 0;\n',
    );
    await cliFixture.git('add', 'example.ts');
    const result = await execute(
      process.execPath,
      [
        process.env.npm_execpath ?? '',
        'exec',
        'tsx',
        'apps/cli/src/index.ts',
        'review',
        '--repo',
        cliFixture.root,
        '--staged',
        '--profile',
        'standard',
        '--review-options',
        JSON.stringify({
          agentModels: { security: { model: 'fixture', endpoint: config.model.endpoint } },
        }),
        '--verify',
        '--json',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, REVIEWLAB_USER_CONFIG: fixture.configFile },
        timeout: 30000,
      },
    );
    const session = JSON.parse(result.stdout) as {
      status: string;
      plan: { options: { profile: string } };
      findings: { attributions: unknown[]; verified: boolean }[];
    };
    expect(session.status).toBe('completed');
    expect(session.plan.options.profile).toBe('standard');
    expect(session.findings).toHaveLength(1);
    expect(session.findings[0]?.attributions).toHaveLength(3);
    expect(session.findings[0]?.verified).toBe(true);
    const saved = JSON.parse(result.stdout) as { id: string; revision: number };
    const rerun = await execute(
      process.execPath,
      [
        process.env.npm_execpath ?? '',
        'exec',
        'tsx',
        'apps/cli/src/index.ts',
        'rerun',
        '--repo',
        cliFixture.root,
        '--session',
        saved.id,
        '--revision',
        String(saved.revision),
        '--json',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, REVIEWLAB_USER_CONFIG: fixture.configFile },
        timeout: 30000,
      },
    );
    const rerunSession = JSON.parse(rerun.stdout) as {
      status: string;
      plan: { options: { profile: string; verify: boolean } };
    };
    expect(rerunSession.status).toBe('completed');
    expect(rerunSession.plan.options).toMatchObject({ profile: 'standard', verify: true });
  } finally {
    await cliFixture.dispose();
  }
});

test('Phase5 conversations, local diff editor, approvals and hash conflicts preserve old evidence', async ({
  page,
}) => {
  const fixture = await runtime();
  const remote: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:5173') && !request.url().startsWith('blob:'))
      remote.push(request.url());
  });
  await writeFile(
    join(fixture.root, 'example.ts'),
    'export const divide = (value: number) => value / 2;\n',
  );
  await page.goto(`/#token=${fixture.token}`);
  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/v1/sessions'),
  );
  await page.getByRole('button', { name: 'Review staged changes' }).click();
  const created = (await (await createdResponse).json()) as { snapshot: { id: string } };
  await expect(page.getByText(`Snapshot ${created.snapshot.id}`, { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Division by zero' })).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Thread', exact: true })
    .selectOption({ label: 'Division by zero' });
  await page.getByLabel('Message', { exact: true }).fill('Keep this frozen evidence.');
  await page.getByRole('button', { name: 'Save message', exact: true }).click();
  await expect(page.getByText('Keep this frozen evidence.', { exact: true })).toBeVisible();
  await page.getByLabel('Message kind').selectOption('question');
  await page.getByLabel('Message', { exact: true }).fill('What is a safe fix?');
  await page.getByRole('button', { name: 'Send question to model' }).click();
  await expect(
    page.getByText('Suggested answer: use a nonzero denominator. No tests were run.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'example.ts:1 (new)', exact: true }).click();
  await page.getByRole('button', { name: 'Open split/unified code editor' }).click();
  await expect(page.locator('.monaco-diff-editor')).toBeVisible();
  await page.getByLabel('Diff layout').selectOption('unified');
  await expect(page.locator('.monaco-diff-editor')).toBeVisible();
  await page.getByText('Propose and approve a file fix', { exact: true }).click();
  await page.getByLabel('Changed text file').selectOption('example.ts');
  await page
    .getByLabel('Proposed full-file replacement')
    .fill('export const divide = (value: number) => value / 3;\n');
  await page.getByRole('button', { name: 'Create exact patch preview' }).click();
  await expect(page.getByLabel('Patch preview for example.ts')).toContainText('value / 3');
  await page.getByRole('button', { name: 'Review application side effects' }).click();
  await page.getByRole('button', { name: 'Approve this exact patch and destination' }).click();
  await page.getByRole('button', { name: 'Apply approved patch to working file' }).click();
  await expect(page.locator('.patches').getByRole('alert')).toContainText('File hash conflict');
  expect(await readFile(join(fixture.root, 'example.ts'), 'utf8')).toContain('value / 2');
  await page.getByRole('button', { name: 'Create exact patch preview' }).click();
  await page.getByRole('button', { name: 'Review application side effects' }).click();
  await page.getByRole('button', { name: 'Approve this exact patch and destination' }).click();
  await writeFile(
    join(fixture.root, 'example.ts'),
    'export const divide = (value: number) => value / 0;\n',
  );
  await page.getByRole('button', { name: 'Apply approved patch to working file' }).click();
  await expect(page.getByText('Applied at', { exact: false })).toBeVisible();
  expect(await readFile(join(fixture.root, 'example.ts'), 'utf8')).toContain('value / 3');
  await expect(page.locator('[id="new:example.ts:1"]')).toContainText('value / 0');
  await page.screenshot({ path: 'test-results/phase-five-workspace.png', fullPage: true });
  await page.reload();
  await page.getByLabel('API connection token').fill(fixture.token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Thread', exact: true })
    .selectOption({ label: 'Division by zero' });
  await expect(page.getByText('Keep this frozen evidence.', { exact: true })).toBeVisible();
  expect(remote).toEqual([]);
});

test('GitHub PR browser capture, explicit comment confirmation, reopen and force-push refresh', async ({
  page,
  request,
}) => {
  const fixture = JSON.parse(await readFile(fixtureStatePath, 'utf8')) as {
    token: string;
    root: string;
    githubRoot: string;
    githubFirst: string;
    githubSecond: string;
  };
  const headers = {
    authorization: `Bearer ${fixture.token}`,
    origin: 'http://127.0.0.1:4317',
    'x-reviewlab-csrf': '1',
  };
  const health = await request.get('http://127.0.0.1:4317/api/v1/health', { headers });
  const { target } = await health.json();
  await request.post('http://127.0.0.1:4317/api/v1/config', {
    headers,
    data: { model: { ...target, model: 'fixture', privacy: 'cloud-allowed' }, allowCloud: false },
  });
  const outgoing: string[] = [];
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== 'http://127.0.0.1:5173') {
      outgoing.push(route.request().url());
      await route.abort();
    } else await route.continue();
  });
  try {
    const index = (await execute('git', ['write-tree'], { cwd: fixture.root })).stdout;
    await page.goto(`/#token=${fixture.token}`);
    const launch = page.locator('.github-launch');
    await launch.getByText('Review a GitHub pull request', { exact: true }).click();
    await launch.getByLabel('PR number or github.com PR URL').fill('12');
    await launch.getByLabel('Allow GitHub read access for this capture').check();
    await expect(launch.getByRole('button', { name: 'Capture PR & review locally' })).toBeEnabled();
    await launch.getByRole('button', { name: 'Capture PR & review locally' }).click();
    const panel = page.locator('.github-context');
    await expect(panel.getByRole('heading', { level: 2 })).toContainText('Browser PR fixture');
    await expect(
      page.getByRole('heading', { name: 'Division by zero', exact: true }),
    ).toBeVisible();
    await panel.getByText('PR description, discussion & external checks', { exact: false }).click();
    await expect(
      panel.getByText('Qodo context: inspect denominator.', { exact: false }),
    ).toBeVisible();
    await panel.getByText('Preview a GitHub comment', { exact: true }).click();
    await panel.getByLabel('Division by zero', { exact: true }).check();
    await panel.getByRole('button', { name: 'Prepare exact comment preview' }).click();
    await expect(panel.locator('.publication-preview pre')).toContainText(fixture.githubFirst);
    const publish = panel.getByRole('button', {
      name: 'Confirm & publish this exact comment to GitHub',
    });
    await expect(publish).toBeDisabled();
    await panel
      .getByLabel('Allow GitHub requests for refresh or separately confirmed publication')
      .check();
    await publish.click();
    await expect(panel.getByRole('link', { name: 'Open published comment' })).toBeVisible();
    await panel.screenshot({ path: 'test-results/phase-six-github.png' });
    await page.reload();
    await page.getByLabel('API connection token').fill(fixture.token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(panel.getByRole('heading', { level: 2 })).toContainText('Browser PR fixture');
    await execute('git', ['update-ref', 'refs/heads/main', fixture.githubSecond], {
      cwd: fixture.githubRoot,
    });
    await panel
      .getByLabel('Allow GitHub requests for refresh or separately confirmed publication')
      .check();
    await panel.getByRole('button', { name: 'Refresh PR & review new snapshot' }).click();
    await expect(panel).toContainText(fixture.githubSecond);
    await panel.getByText('PR description, discussion & external checks', { exact: false }).click();
    await expect(panel).toContainText('OUTDATED');
    await page.getByLabel('View run and its frozen snapshot').selectOption({ index: 1 });
    await expect(panel).toContainText(fixture.githubFirst);
    await expect(panel).toContainText('Historical PR head.');
    expect((await execute('git', ['write-tree'], { cwd: fixture.root })).stdout).toBe(index);
    expect(outgoing).toEqual([]);
  } finally {
    await request.post('http://127.0.0.1:4317/api/v1/config', {
      headers,
      data: { model: { ...target, privacy: 'local-only' } },
    });
  }
});
