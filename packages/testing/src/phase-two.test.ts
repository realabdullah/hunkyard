import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTarget, updateConfig } from '@hunkyard/context';
import { createRuntime, startServer } from '@hunkyard/server/runtime';
import { createSqliteSessionStore } from '@hunkyard/storage';
import { expect, test } from 'vitest';
import { createGitFixture } from './git-fixture';

const setup = async () => {
  const fixture = await createGitFixture();
  const config = await mkdtemp(join(tmpdir(), 'hunkyard-phase2-'));
  const previous = process.env.HUNKYARD_USER_CONFIG;
  process.env.HUNKYARD_USER_CONFIG = join(config, 'config.json');
  await writeFile(join(fixture.root, 'example.ts'), 'export const value = 2;\n');
  await fixture.git('add', 'example.ts');
  let seen: (() => void) | undefined;
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString()) as { model: string })
      : null;
    if (input?.model === 'slow') {
      seen?.();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify(
        request.url === '/api/tags'
          ? { models: [{ name: 'fixture' }] }
          : { message: { content: '{"findings":[]}' } },
      ),
    );
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const address = model.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture model');
  await updateConfig(fixture.root, {
    model: {
      provider: 'ollama',
      endpoint: `http://127.0.0.1:${address.port}`,
      model: 'fixture',
      privacy: 'local-only',
      timeoutMs: 30000,
    },
  });
  return {
    ...fixture,
    model,
    configFile: process.env.HUNKYARD_USER_CONFIG,
    onRequest: (callback: () => void) => {
      seen = callback;
    },
    dispose: async () => {
      model.closeAllConnections();
      await new Promise<void>((resolve) => model.close(() => resolve()));
      if (previous === undefined) delete process.env.HUNKYARD_USER_CONFIG;
      else process.env.HUNKYARD_USER_CONFIG = previous;
      await fixture.dispose();
      await rm(config, { recursive: true, force: true });
    },
  };
};

test('durable service reruns retained or recaptured snapshots without rewriting older run provenance', async () => {
  const fixture = await setup();
  const runtime = await createRuntime(fixture.root);
  try {
    const first = await runtime.service.start();
    await runtime.service.execute(first.id);
    const completed = await runtime.service.get(first.id);
    if (!completed) throw new Error('Missing session');
    await writeFile(join(fixture.root, 'example.ts'), 'export const value = 3;\n');
    await fixture.git('add', 'example.ts');
    const rerun = await runtime.service.rerun(first.id, completed.revision);
    if (!rerun) throw new Error('Missing rerun');
    expect(rerun.snapshot).toEqual(first.snapshot);
    expect(rerun.runId).not.toBe(first.runId);
    await runtime.service.execute(first.id);
    const second = await runtime.service.get(first.id);
    if (!second) throw new Error('Missing second run');
    await expect(runtime.service.rerun(first.id, completed.revision, true)).rejects.toThrow(
      'revision conflict',
    );
    const captured = await runtime.service.rerun(first.id, second.revision, true);
    expect(captured?.snapshot.diff).toContain('value = 3');
    await runtime.service.execute(first.id);
    const history = await runtime.service.runs(first.id);
    expect(history).toHaveLength(3);
    expect(history[0]?.snapshot).toEqual(first.snapshot);
    expect(
      history.every(
        (run) => run.status === 'completed' && run.context?.snapshotId === run.snapshot.id,
      ),
    ).toBe(true);
    expect(await runtime.service.snapshots(first.id)).toHaveLength(2);
    expect((await runtime.service.get(first.id))?.state).toBe('interactive');
    await expect(createRuntime(fixture.root)).rejects.toThrow('owns this repository');
  } finally {
    await runtime.close();
    await fixture.dispose();
  }
});

test('actual killed reviewer is recovered once by new runtime; a reader never recovers a live owner', async () => {
  const fixture = await setup();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const target = await loadTarget(fixture.root);
    await updateConfig(fixture.root, { model: { ...target, model: 'slow' } });
    const requested = new Promise<void>((resolve) => fixture.onRequest(resolve));
    child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/cli/src/index.ts',
        'review',
        '--staged',
        '--repo',
        fixture.root,
        '--json',
      ],
      {
        env: { ...process.env, HUNKYARD_USER_CONFIG: fixture.configFile },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const exited = new Promise<void>((resolve, reject) => {
      child?.once('exit', () => resolve());
      child?.once('error', reject);
    });
    await Promise.race([
      requested,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Review never reached model')), 7000).unref(),
      ),
    ]);
    const reader = await createRuntime(fixture.root, { writer: false });
    const active = (await reader.service.list())[0];
    expect(active?.status).toBe('running');
    await reader.close();
    await expect(createRuntime(fixture.root)).rejects.toThrow('owns this repository');
    child.kill('SIGKILL');
    await exited;
    const recovered = await createRuntime(fixture.root);
    try {
      expect(recovered.recovered).toBe(1);
      const session = active ? await recovered.service.get(active.id) : null;
      expect(session?.status).toBe('cancelled');
      expect(session?.state).toBe('interactive');
      expect(session?.snapshot).toEqual(active?.snapshot);
      await updateConfig(fixture.root, { model: target });
      if (!session) throw new Error('Recovered session missing');
      await recovered.service.rerun(session.id, session.revision);
      await recovered.service.execute(session.id);
      expect(await recovered.service.runs(session.id)).toHaveLength(2);
    } finally {
      await recovered.close();
    }
    const again = await createRuntime(fixture.root);
    expect(again.recovered).toBe(0);
    await again.close();
  } finally {
    child?.kill('SIGKILL');
    await fixture.dispose();
  }
}, 15000);

test('authenticated SSE replays persisted events from a cursor and diagnostics export has no source', async () => {
  const fixture = await setup();
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing API port');
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await startServer(fixture.root, address.port);
  try {
    const headers = {
      authorization: `Bearer ${server.token}`,
      origin: server.origin,
      'x-hunkyard-csrf': '1',
      'content-type': 'application/json',
    };
    const first = await server.service.start();
    await server.service.execute(first.id);
    const stored = await createSqliteSessionStore(fixture.root).events(first.id, 0);
    const after = stored[2]?.cursor ?? 0;
    const controller = new AbortController();
    const response = await fetch(
      `${server.origin}/api/v1/sessions/${first.id}/events?after=${after}`,
      { headers, signal: controller.signal },
    );
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing stream');
    let output = '';
    try {
      while (!output.includes(`id: ${stored.at(-1)?.cursor}\n`)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
      }
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
    const events = output
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { cursor: number });
    expect(events.map((event) => event.cursor)).toEqual(
      stored.filter((event) => event.cursor > after).map((event) => event.cursor),
    );
    expect(events.map((event) => event.cursor)).not.toContain(after);
    const unauthorized = await fetch(`${server.origin}/api/v1/sessions/${first.id}/events`);
    expect(unauthorized.status).toBe(401);
    const exported = await fetch(`${server.origin}/api/v1/sessions/${first.id}/export`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    const diagnostic = await exported.text();
    expect(diagnostic).not.toContain('export const value');
    expect(diagnostic).not.toContain(fixture.root);
    const before = await server.service.get(first.id);
    const rerun = await fetch(`${server.origin}/api/v1/sessions/${first.id}/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ revision: before?.revision, recapture: false }),
    });
    expect(rerun.status).toBe(202);
    await server.service.execute(first.id);
    expect(await server.service.runs(first.id)).toHaveLength(2);
  } finally {
    await server.close();
    await fixture.dispose();
  }
}, 15000);
