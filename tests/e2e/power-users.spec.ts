import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createGitFixture } from '@hunkyard/testing';
import { expect, test } from '@playwright/test';

const execute = promisify(execFile);
test('CLI policy, workflow, semantic opt-in, consent fingerprint and analytics work without touching developer edits', async () => {
  const fixture = await createGitFixture();
  const directory = await mkdtemp(join(tmpdir(), 'hunkyard-power-cli-'));
  let embeddings = 0;
  let inference = 0;
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString()) as { input?: string[] };
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/embed') {
      embeddings++;
      response.end(JSON.stringify({ embeddings: input.input?.map(() => [1, 0]) }));
    } else {
      inference++;
      response.end(
        JSON.stringify({
          message: { content: '{"findings":[]}' },
          prompt_eval_count: 10,
          eval_count: 10,
        }),
      );
    }
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const address = model.address();
  if (!address || typeof address === 'string') throw new Error('Missing model address');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const run = (...args: string[]) =>
    execute(
      process.execPath,
      ['--import', 'tsx', 'apps/cli/src/index.ts', ...args, '--repo', fixture.root, '--json'],
      {
        env: { ...process.env, HUNKYARD_USER_CONFIG: join(directory, 'config.json') },
        timeout: 20000,
      },
    );
  try {
    await writeFile(join(fixture.root, 'related.ts'), 'export const expiry = 30;\n');
    await fixture.git('add', '.');
    await fixture.git('commit', '-m', 'test: establish retrieval context');
    await writeFile(join(fixture.root, 'example.ts'), 'export const lifetime = 30;\n');
    await fixture.git('add', 'example.ts');
    await writeFile(join(fixture.root, 'example.ts'), 'export const lifetime = 60; // unstaged\n');
    const before = await fixture.git('diff', 'HEAD');
    const index = await fixture.git('write-tree');
    await run('config', '--provider', 'ollama', '--model', 'fixture', '--endpoint', endpoint);
    const preview = JSON.parse((await run('plan')).stdout) as { fingerprint: string };
    await expect(run('review', '--staged', '--expected-plan', 'changed')).rejects.toThrow();
    expect(inference).toBe(0);
    const basic = JSON.parse(
      (await run('review', '--staged', '--expected-plan', preview.fingerprint)).stdout,
    );
    expect(basic.status).toBe('completed');
    expect(basic.context.semantic).toBeUndefined();
    expect(embeddings).toBe(0);
    const file = join(directory, 'policy.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        name: 'Cancellation',
        rules: ['Check cancellation.'],
        exclude: ['private/**'],
        review: {
          verify: true,
          workflow: {
            version: 1,
            nodes: [
              { agent: 'correctness' },
              { agent: 'security', after: ['correctness'] },
              { agent: 'verifier', after: ['correctness', 'security'] },
            ],
          },
        },
      }),
    );
    expect(JSON.parse((await run('policy-inspect', '--file', file)).stdout).name).toBe(
      'Cancellation',
    );
    await expect(run('review', '--staged', '--policy', file)).rejects.toThrow();
    await expect(run('review', '--staged', '--semantic-model', 'fixture')).rejects.toThrow();
    expect(embeddings).toBe(0);
    const advanced = JSON.parse(
      (
        await run(
          'review',
          '--staged',
          '--policy',
          file,
          '--allow-policy',
          '--semantic-model',
          'fixture',
          '--semantic-endpoint',
          endpoint,
          '--allow-local-embeddings',
        )
      ).stdout,
    );
    expect(advanced.status).toBe('completed');
    expect(advanced.plan.options.workflow.nodes).toHaveLength(3);
    expect(
      advanced.context.entries.find((entry: { reason: string }) => entry.reason === 'semantic')
        .path,
    ).toBe('related.ts');
    expect(embeddings).toBe(2);
    expect(JSON.parse((await run('analytics')).stdout).runs).toBe(2);
    await rm(file);
    const rerun = JSON.parse(
      (await run('rerun', '--session', advanced.id, '--revision', String(advanced.revision)))
        .stdout,
    );
    expect(rerun.status).toBe('completed');
    expect(
      rerun.policy.sources.some(
        (entry: { format: string }) => entry.format === 'shareable-policy-v1',
      ),
    ).toBe(true);
    expect(rerun.context.semantic).toBeUndefined();
    expect(embeddings).toBe(2);
    expect(await fixture.git('write-tree')).toBe(index);
    expect(await fixture.git('diff', 'HEAD')).toBe(before);
  } finally {
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('hosted settings name the destination and clear consent when provider or endpoint changes', async ({
  page,
}) => {
  const fixture = await createGitFixture();
  const directory = await mkdtemp(join(tmpdir(), 'hunkyard-hosted-ui-'));
  const previous = process.env.HUNKYARD_USER_CONFIG;
  process.env.HUNKYARD_USER_CONFIG = join(directory, 'config.json');
  const { startServer } = await import('@hunkyard/server/runtime');
  const server = await startServer(fixture.root, 4319);
  try {
    await page.goto(`${server.origin}/#token=${server.token}`);
    await page.getByRole('button', { name: 'Model & privacy', exact: true }).click();
    await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('deepseek');
    await expect(page.getByLabel('Endpoint', { exact: true })).toHaveValue(
      'https://api.deepseek.com',
    );
    await expect(page.getByLabel('Model', { exact: true })).toHaveValue('deepseek-flash');
    const consent = page.getByRole('checkbox', { name: /I authorize this repository/ });
    await expect(consent).not.toBeChecked();
    await expect(consent).toHaveAccessibleName(/deepseek at https:\/\/api.deepseek.com/);
    await page
      .getByRole('combobox', { name: 'Privacy', exact: true })
      .selectOption('cloud-allowed');
    await consent.check();
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(page.getByRole('status')).toContainText(
      'Settings saved. No review has been sent.',
    );
    expect((await server.service.plan()).baseTarget.approvedHostedOrigins).toEqual([
      'https://api.deepseek.com',
    ]);
    await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('agentrouter');
    await expect(consent).not.toBeChecked();
    await expect(page.getByLabel('Endpoint', { exact: true })).toHaveValue(
      'https://co.agentrouter.org/v1',
    );
    await expect(consent).toHaveAccessibleName(/upstream model providers/);
    await page.getByLabel('Model', { exact: true }).fill('gpt-5.5');
    await consent.check();
    await page.getByLabel('Endpoint', { exact: true }).fill('https://agentrouter.org/v1');
    await expect(consent).not.toBeChecked();
    expect(await server.service.list()).toEqual([]);
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.HUNKYARD_USER_CONFIG;
    else process.env.HUNKYARD_USER_CONFIG = previous;
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
