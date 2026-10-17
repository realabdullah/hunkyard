import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePullRequest, pullRequestAdvisory, pullRequestLocation } from '@reviewlab/domain';
import { capturePullRequest, runBytes } from '@reviewlab/git';
import { createGitHubClient, createGitHubProvider } from '@reviewlab/providers';
import { createApi } from '@reviewlab/server/app';
import { createSqliteSessionStore } from '@reviewlab/storage';
import { expect, test, vi } from 'vitest';
import { request, setup } from './phase-six-fixture';

test('PR capture/reopen/force-push retain original anchors without modifying index, files or refs', async () => {
  const f = await setup();
  try {
    const index = await f.git('write-tree');
    const refs = await f.git('show-ref');
    const initial = await f.start();
    expect(initial.snapshot.diff).toContain('+export const value = 2;');
    expect(
      initial.snapshot.pullRequest?.comments.find((entry) => entry.kind === 'inline')?.outdated,
    ).toBe(false);
    expect(initial.snapshot.pullRequest?.checks[1]?.url).toBeNull();
    expect((await createSqliteSessionStore(f.root).get(initial.id))?.snapshot).toEqual(
      initial.snapshot,
    );
    const count = f.calls.length;
    f.target.privacy = 'local-only';
    await expect(f.service.startPullRequest(request)).rejects.toThrow('local-only');
    await expect(
      f.service.rerun(initial.id, initial.revision, true, undefined, undefined, true),
    ).rejects.toThrow('local-only');
    expect(f.calls).toHaveLength(count);
    const frozen = await f.service.rerun(initial.id, initial.revision);
    expect(frozen?.snapshot).toEqual(initial.snapshot);
    await f.service.execute(initial.id);
    expect(f.calls).toHaveLength(count);
    f.target.privacy = 'cloud-allowed';
    f.move();
    const previous = await f.service.get(initial.id);
    if (!previous) throw new Error('Missing session');
    await expect(f.service.rerun(initial.id, previous.revision, true)).rejects.toThrow();
    const latest = await f.service.rerun(
      initial.id,
      previous.revision,
      true,
      undefined,
      undefined,
      true,
    );
    expect(latest?.snapshot.pullRequest?.headSha).toBe(f.second);
    expect(
      latest?.snapshot.pullRequest?.comments.find((entry) => entry.kind === 'inline')?.outdated,
    ).toBe(true);
    expect(
      (await f.service.runs(initial.id)).find((run) => run.runId === initial.runId)?.snapshot,
    ).toEqual(initial.snapshot);
    expect(await f.git('write-tree')).toBe(index);
    expect(await f.git('show-ref')).toBe(refs);
    expect(await readFile(join(f.root, 'example.ts'), 'utf8')).toContain('value = 8');
    expect(f.published).toHaveLength(0);
    expect(pullRequestAdvisory(initial.snapshot, [], [])).not.toContain('Original inline context');
  } finally {
    await f.service.shutdown();
    await f.dispose();
  }
});

test('publication requires exact preview, explicit confirmation, current PR and durable duplicate guard', async () => {
  const f = await setup(true);
  try {
    const session = await f.start();
    const raw = { revision: 0, runId: session.runId, findingIds: [session.findings[0]?.id] };
    const preview = await f.service.github.preview(session.id, raw);
    expect(preview.body).toContain(`/blob/${f.first}/example.ts#L1`);
    expect(preview.body).toContain('does not approve');
    expect(preview.body).toContain('\\!\\[pixel\\]\\(https://evil\\.example/image\\)');
    expect(preview.body).not.toContain('![pixel]');
    expect(preview.anchors[0]).toMatchObject({
      commit_id: f.first,
      path: 'example.ts',
      line: 1,
      side: 'RIGHT',
      sourceSha: f.first,
    });
    const old = {
      ...session.findings[0],
      file: 'example.ts',
      line: 1,
      side: 'old' as const,
      severity: 'high' as const,
      title: 'Old source',
      evidence: 'export const value = 1;',
      explanation: 'Old side test',
      recommendation: 'Use intended value',
    };
    expect(pullRequestLocation(session.snapshot, old)).toMatchObject({
      side: 'LEFT',
      sourceSha: f.base,
      commit_id: f.first,
    });
    expect(() => pullRequestLocation(session.snapshot, { ...old, line: 999 })).toThrow(
      'diff location',
    );
    expect(f.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
    await expect(
      f.service.github.publish(session.id, preview.id, { revision: 1, allowGitHub: true }),
    ).rejects.toThrow();
    await expect(
      f.service.github.publish(session.id, preview.id, {
        revision: 0,
        allowGitHub: true,
        confirm: true,
      }),
    ).rejects.toThrow('revision conflict');
    expect(await f.service.github.preview(session.id, { ...raw, revision: 1 })).toEqual(preview);
    const published = await f.service.github.publish(session.id, preview.id, {
      revision: 1,
      allowGitHub: true,
      confirm: true,
    });
    expect(published.status).toBe('published');
    expect(f.published).toHaveLength(1);
    const state = await f.service.interaction.read(session.id);
    expect(
      await f.service.github.publish(session.id, preview.id, {
        revision: state.revision,
        allowGitHub: true,
        confirm: true,
      }),
    ).toEqual(published);
    expect(f.published).toHaveLength(1);
    expect(
      (await createSqliteSessionStore(f.root).interaction(session.id)).publications[0],
    ).toEqual(published);
    expect(JSON.stringify(await f.store.export(session.id))).not.toContain('Seeded issue');
    const again = await f.start();
    const secondPreview = await f.service.github.preview(again.id, {
      revision: 0,
      runId: again.runId,
      findingIds: [again.findings[0]?.id],
    });
    await expect(
      f.service.github.publish(again.id, secondPreview.id, {
        revision: 1,
        allowGitHub: true,
        confirm: true,
      }),
    ).rejects.toThrow('already appear');
    expect(f.published).toHaveLength(1);
    const next = await f.service.rerun(session.id, session.revision);
    if (!next) throw new Error('Missing rerun');
    await f.service.execute(session.id);
    const reviewed = await f.service.get(session.id);
    const currentState = await f.service.interaction.read(session.id);
    await expect(
      f.service.github.preview(session.id, {
        revision: currentState.revision,
        runId: reviewed?.runId,
        findingIds: [reviewed?.findings[0]?.id],
      }),
    ).rejects.toThrow('already have a publication attempt');
  } finally {
    await f.service.shutdown();
    await f.dispose();
  }
});

test('moved or closed PR refuses publication; lost replies recover receipt without repost', async () => {
  const f = await setup();
  try {
    const session = await f.start();
    const preview = await f.service.github.preview(session.id, {
      revision: 0,
      runId: session.runId,
      findingIds: [session.findings[0]?.id],
    });
    f.move();
    await expect(
      f.service.github.publish(session.id, preview.id, {
        revision: 1,
        allowGitHub: true,
        confirm: true,
      }),
    ).rejects.toThrow('PR changed');
    expect(f.published).toHaveLength(0);
    f.restore();
    f.closePR();
    await expect(
      f.service.github.publish(session.id, preview.id, {
        revision: 1,
        allowGitHub: true,
        confirm: true,
      }),
    ).rejects.toThrow('closed');
  } finally {
    await f.service.shutdown();
    await f.dispose();
  }
  const lost = await setup();
  try {
    const session = await lost.start();
    const preview = await lost.service.github.preview(session.id, {
      revision: 0,
      runId: session.runId,
      findingIds: [session.findings[0]?.id],
    });
    lost.lose();
    await expect(
      lost.service.github.publish(session.id, preview.id, {
        revision: 1,
        allowGitHub: true,
        confirm: true,
      }),
    ).rejects.toThrow('uncertain');
    const state = await lost.service.interaction.read(session.id);
    expect(state.publications[0]?.status).toBe('uncertain');
    const remoteReceipt = lost.published.pop();
    await expect(
      lost.service.github.publish(session.id, preview.id, {
        revision: state.revision,
        allowGitHub: true,
        confirm: true,
      }),
    ).rejects.toThrow('automatic repost is disabled');
    expect(lost.calls.filter((entry) => entry.method === 'POST')).toHaveLength(1);
    if (remoteReceipt) lost.published.push(remoteReceipt);
    const recovered = await lost.service.github.publish(session.id, preview.id, {
      revision: state.revision,
      allowGitHub: true,
      confirm: true,
    });
    expect(recovered.status).toBe('published');
    expect(lost.published).toHaveLength(1);
  } finally {
    await lost.service.shutdown();
    await lost.dispose();
  }
});

test('API launches PR, refresh requires consent, and local-only network access fails before provider calls', async () => {
  const f = await setup();
  try {
    const app = createApi({
      service: f.service,
      token: 'fixture-token',
      origin: 'http://127.0.0.1:4317',
      target: async () => f.target,
      configure: async () => f.target,
      probe: async () => ({}),
    });
    const send = (path: string, body: unknown) =>
      app.request(`http://127.0.0.1:4317/api/v1${path}`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:4317',
          authorization: 'Bearer fixture-token',
          origin: 'http://127.0.0.1:4317',
          'x-reviewlab-csrf': '1',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    f.target.privacy = 'local-only';
    expect((await send('/github/reviews', request)).status).toBe(400);
    expect(f.calls).toHaveLength(0);
    f.target.privacy = 'cloud-allowed';
    const response = await send('/github/reviews', request);
    expect(response.status).toBe(202);
    const value = (await response.json()) as { id: string; revision: number };
    await vi.waitFor(async () => expect((await f.service.get(value.id))?.status).toBe('completed'));
    const completed = await f.service.get(value.id);
    expect(
      (await send(`/sessions/${value.id}/github/refresh`, { revision: completed?.revision }))
        .status,
    ).toBe(400);
  } finally {
    await f.service.shutdown();
    await f.dispose();
  }
});

test('GitHub bounded pagination, retry-after, auth failures and non-retriable POST contracts', async () => {
  const wait = vi.fn(async (_ms: number) => {});
  let calls = 0;
  const client = createGitHubClient(
    async () =>
      ++calls === 1
        ? { status: 429, headers: { 'retry-after': '1' }, data: {} }
        : { status: 200, headers: {}, data: [] },
    wait,
  );
  expect(await client.list('repos/owner/repo/issues/12/comments')).toEqual([]);
  expect(wait).toHaveBeenCalledWith(1000);
  for (const status of [401, 403, 429, 503]) {
    const transport = vi.fn(async () => ({ status, headers: { 'retry-after': '120' }, data: {} }));
    await expect(
      createGitHubClient(transport, wait).request('POST', 'repos/owner/repo/issues/12/comments', {
        body: 'test',
      }),
    ).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  }
  let page = 0;
  const paged = createGitHubClient(async (_method, path) => {
    page += 1;
    expect(path).toContain(`page=${page}`);
    return {
      status: 200,
      headers: {},
      data: page === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 101 }],
    };
  }, wait);
  expect(await paged.list('repos/owner/repo/issues/12/comments')).toHaveLength(101);
  const oversized = createGitHubClient(
    async () => ({ status: 200, headers: {}, data: Array(100).fill({}) }),
    wait,
  );
  await expect(oversized.list('repos/owner/repo/issues/12/comments')).rejects.toThrow(
    'pagination budget',
  );
  expect(parsePullRequest('https://github.com/owner/repo/pull/12')).toEqual(request);
  expect(() => parsePullRequest('https://evil.example/owner/repo/pull/12')).toThrow();
});

test('metadata/fetch head races fail visibly and repository identity cannot escape the checkout', async () => {
  const f = await setup();
  try {
    let metadataReads = 0;
    const provider = createGitHubProvider(async (method, path, body) => {
      if (path.endsWith('/pulls/12') && ++metadataReads === 2) f.move();
      return f.transport(method, path, body);
    });
    await expect(provider.read(request)).rejects.toThrow('changed during ingestion');
    await expect(
      f.service.startPullRequest({ ...request, repository: 'other/repo' }),
    ).rejects.toThrow('does not match');
    const before = f.calls.length;
    await expect(
      f.service.startPullRequest({ ...request, repository: 'owner/..' }),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(before);
    f.restore();
    const context = await f.github.read(request);
    f.move();
    await expect(
      capturePullRequest(f.root, context, [], async (cwd, ...args) => {
        const effective =
          args[0] === 'fetch'
            ? [
                'fetch',
                '--no-tags',
                '--depth=1',
                f.root,
                args.at(-1)?.startsWith('refs/pull/') ? f.second : (args.at(-1) ?? ''),
              ]
            : args;
        return (await runBytes(cwd, effective)).toString('utf8');
      }),
    ).rejects.toThrow('head changed');
    expect(await f.service.list()).toEqual([]);
  } finally {
    await f.service.shutdown();
    await f.dispose();
  }
});
