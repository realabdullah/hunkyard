import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { createReviewService } from '@hunkyard/core';
import { ModelTargetSchema, type ReviewSession } from '@hunkyard/domain';
import { captureStaged } from '@hunkyard/git';
import {
  createFileSessionStore,
  createSqliteSessionStore,
  historyDatabasePath,
  migrateFileHistory,
} from '@hunkyard/storage';
import { expect, test } from 'vitest';
import { createGitFixture } from './git-fixture';

const setup = async () => {
  const fixture = await createGitFixture();
  await writeFile(join(fixture.root, 'example.ts'), 'export const value = 2;\n');
  await fixture.git('add', 'example.ts');
  const snapshot = await captureStaged(fixture.root);
  const bundle = { version: 1 as const, instructions: [], sources: [], exclusions: [] };
  const session: ReviewSession = {
    version: 2,
    id: randomUUID(),
    revision: 0,
    status: 'queued',
    snapshot,
    policy: { ...bundle, hash: createHash('sha256').update(JSON.stringify(bundle)).digest('hex') },
    target: ModelTargetSchema.parse({ repository: snapshot.repoRoot, cloudConsent: false }),
    findings: [],
    instructions: [],
    createdAt: new Date().toISOString(),
  };
  return {
    ...fixture,
    root: snapshot.repoRoot,
    session,
    path: join(fixture.root, '.hunkyard', 'sqlite', 'history.db'),
  };
};

test('SQLite retains provenance across reopen, enforces writer revisions and rolls back invalid input', async () => {
  const fixture = await setup();
  try {
    const { root, session, path } = fixture;
    const store = createSqliteSessionStore(root);
    const service = createReviewService({
      root,
      store,
      captureStaged: async () => session.snapshot,
      resolvePolicy: async () => session.policy,
      loadTarget: async () => session.target,
      agent: { review: async () => [] },
    });
    const created = await service.start();
    await service.execute(created.id);
    const saved = await createSqliteSessionStore(root).get(created.id);
    expect(saved?.status).toBe('completed');
    if (!saved) throw new Error('Missing history');
    const writes = await Promise.allSettled([
      store.save({ ...saved, revision: saved.revision + 1 }),
      createSqliteSessionStore(root).save({ ...saved, revision: saved.revision + 1 }),
    ]);
    expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(
      store.save({
        ...saved,
        revision: saved.revision + 2,
        snapshot: { ...saved.snapshot, createdAt: '2026-10-14T00:00:00.000Z' },
      }),
    ).rejects.toThrow('immutable');
    expect((await store.get(saved.id))?.revision).toBe(saved.revision + 1);
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
      const runPayload = db
        .prepare('SELECT data FROM runs WHERE session_id = ?')
        .get(created.id)?.data;
      expect(typeof runPayload === 'string' && JSON.parse(runPayload)).not.toHaveProperty(
        'snapshot',
      );
      expect(typeof runPayload === 'string' && JSON.parse(runPayload)).not.toHaveProperty('policy');
      expect(
        db.prepare('SELECT snapshot_id,policy_hash FROM runs WHERE session_id = ?').get(created.id),
      ).toMatchObject({ snapshot_id: saved.snapshot.id, policy_hash: saved.policy.hash });
      expect(db.prepare('SELECT count(*) AS count FROM snapshots').get()?.count).toBe(1);
      expect(db.prepare('SELECT count(*) AS count FROM migrations').get()?.count).toBe(9);
      expect(() => db.prepare('UPDATE snapshots SET data = data').run()).toThrow('immutable');
      db.exec('BEGIN IMMEDIATE');
      await expect(store.save({ ...saved, revision: saved.revision + 2 })).rejects.toThrow('busy');
      db.exec('ROLLBACK');
    } finally {
      db.close();
    }
    if (process.platform !== 'win32') expect((await lstat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await fixture.dispose();
  }
});

test('explicit JSON migration is atomic, repeatable, private and preserves source bytes', async () => {
  const fixture = await setup();
  try {
    const { root, session } = fixture;
    const file = createFileSessionStore(root);
    await file.save(session);
    const original = await readFile(join(root, '.hunkyard', 'sessions-v2', `${session.id}.json`));
    const frozen = await readFile(
      join(root, '.hunkyard', 'snapshots-v2', `${session.snapshot.id}.json`),
    );
    const cli = await promisify(execFile)(process.execPath, [
      '--import',
      'tsx',
      'apps/cli/src/index.ts',
      'migrate-history',
      '--repo',
      root,
    ]);
    expect(JSON.parse(cli.stdout)).toMatchObject({ imported: 1, originalsPreserved: true });
    expect(await migrateFileHistory(root)).toEqual({ imported: 0, unchanged: 1 });
    expect(await createSqliteSessionStore(root).get(session.id)).toEqual(session);
    const older = { ...session, id: randomUUID(), createdAt: '2020-01-01T00:00:00.000Z' };
    const newer = { ...session, id: randomUUID(), createdAt: '2030-01-01T00:00:00.000Z' };
    await file.save(older);
    await file.save(newer);
    await file.save({ ...session, status: 'running', revision: 1 });
    await expect(migrateFileHistory(root)).rejects.toThrow('conflicts');
    expect(await createSqliteSessionStore(root).list()).toEqual([session]);
    expect(
      await readFile(join(root, '.hunkyard', 'snapshots-v2', `${session.snapshot.id}.json`)),
    ).toEqual(frozen);
    // Restore exactly the original bytes, then verify malformed history causes no partial import.
    await writeFile(join(root, '.hunkyard', 'sessions-v2', `${session.id}.json`), original);
    await writeFile(join(root, '.hunkyard', 'sessions-v2', `${older.id}.json`), '{}');
    await expect(migrateFileHistory(root)).rejects.toThrow();
    expect(await createSqliteSessionStore(root).list()).toEqual([session]);
    expect(await readFile(join(root, '.hunkyard', 'sessions-v2', `${session.id}.json`))).toEqual(
      original,
    );
  } finally {
    await fixture.dispose();
  }
});

test('SQLite rejects symlink escapes, corrupt input and newer schemas without erasing history', async () => {
  const fixture = await setup();
  const outside = await createGitFixture();
  try {
    const store = createSqliteSessionStore(fixture.root);
    await store.save(fixture.session);
    await symlink(join(outside.root, 'stolen'), `${fixture.path}-wal`);
    await expect(store.list()).rejects.toThrow('Unsafe');
    const { rm } = await import('node:fs/promises');
    await rm(`${fixture.path}-wal`);
    const db = new DatabaseSync(fixture.path);
    db.exec('PRAGMA user_version = 99');
    db.close();
    await expect(store.list()).rejects.toThrow('Unsupported');
    const check = new DatabaseSync(fixture.path);
    expect(check.prepare('SELECT count(*) AS count FROM sessions').get()?.count).toBe(1);
    check.exec('PRAGMA user_version = 1');
    check.prepare('UPDATE sessions SET data = ?').run('{}');
    check.close();
    await expect(store.list()).rejects.toThrow();
    expect(await readdir(outside.root)).not.toContain('stolen');
  } finally {
    await fixture.dispose();
    await outside.dispose();
  }
});

test('abrupt writer termination rolls back the incomplete transaction and releases SQLite locks', async () => {
  const fixture = await setup();
  try {
    const store = createSqliteSessionStore(fixture.root);
    await store.save(fixture.session);
    const script = `const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      db.prepare('UPDATE sessions SET revision = 99').run();
      process.kill(process.pid, 'SIGKILL');`;
    await expect(
      promisify(execFile)(process.execPath, ['-e', script, fixture.path]),
    ).rejects.toThrow();
    expect(await createSqliteSessionStore(fixture.root).get(fixture.session.id)).toEqual(
      fixture.session,
    );
    await store.save({ ...fixture.session, revision: 1, status: 'cancelled' });
    expect((await store.get(fixture.session.id))?.status).toBe('cancelled');
  } finally {
    await fixture.dispose();
  }
});

test('durable runs retain snapshots, immutable outcomes and reconnectable event cursors', async () => {
  const fixture = await setup();
  try {
    const store = createSqliteSessionStore(fixture.root);
    const first = { ...fixture.session, runId: randomUUID() };
    await store.save(first);
    const completed = {
      ...first,
      revision: 1,
      status: 'completed' as const,
      completedAt: new Date().toISOString(),
    };
    await store.save(completed);
    await expect(store.save({ ...completed, revision: 2, error: 'rewrite' })).rejects.toThrow(
      'immutable',
    );
    await writeFile(join(fixture.root, 'example.ts'), 'export const value = 3;\n');
    await fixture.git('add', 'example.ts');
    const snapshot = await captureStaged(fixture.root);
    const next = { ...first, revision: 2, runId: randomUUID(), snapshot };
    await store.save(next);
    expect((await store.runs(first.id)).map((run) => run.status)).toEqual(['completed', 'queued']);
    expect((await store.snapshots(first.id)).map((entry) => entry.id)).toEqual([
      first.snapshot.id,
      snapshot.id,
    ]);
    const events = await store.events(first.id);
    expect(events.filter((event) => event.type === 'run.queued')).toHaveLength(2);
    const cursor = events[2]?.cursor;
    if (!cursor) throw new Error('Missing cursor');
    expect(await createSqliteSessionStore(fixture.root).events(first.id, cursor)).toEqual(
      events.filter((event) => event.cursor > cursor),
    );
    await expect(store.delete(first.id, 2)).rejects.toThrow('Active');
    await store.save({
      ...next,
      revision: 3,
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    });
    const diagnostic = JSON.stringify(await store.export(first.id));
    expect(diagnostic).not.toContain('export const');
    expect(diagnostic).not.toContain(fixture.root);
    expect(diagnostic).not.toContain('127.0.0.1');
    expect(JSON.stringify(await store.export(first.id, false))).toContain('export const');
    expect(await store.usage()).toMatchObject({ sessions: 1, runs: 2, snapshots: 2 });
    await expect(store.delete(first.id, 2)).rejects.toThrow('revision');
    expect(await store.prune({ before: '2099-01-01T00:00:00.000Z', keepLatest: 1 })).toBe(0);
    expect(await store.prune({ before: '2099-01-01T00:00:00.000Z', keepLatest: 0 })).toBe(1);
    expect(await store.usage()).toMatchObject({ sessions: 0, runs: 0, snapshots: 0 });
  } finally {
    await fixture.dispose();
  }
});

test('exclusive runtime ownership protects live work and crash recovery persists cancellation once', async () => {
  const fixture = await setup();
  try {
    const store = createSqliteSessionStore(fixture.root);
    await store.save(fixture.session);
    await store.save({ ...fixture.session, revision: 1, status: 'running' });
    await expect(store.recover()).rejects.toThrow('ownership');
    const lease = await store.acquireRuntime();
    const competing = createSqliteSessionStore(fixture.root);
    await expect(competing.acquireRuntime()).rejects.toThrow('owns');
    await expect(competing.recover()).rejects.toThrow('ownership');
    expect((await competing.get(fixture.session.id))?.status).toBe('running');
    await store.progress(fixture.session.id, fixture.session.id, 'secret source content');
    expect(JSON.stringify(await store.events(fixture.session.id))).not.toContain(
      'secret source content',
    );
    await store.progress(fixture.session.id, fixture.session.id, 'repair (attempt 2)');
    expect((await store.events(fixture.session.id)).at(-1)?.data.message).toBe(
      'repair (attempt 2)',
    );
    expect(await store.recover()).toBe(1);
    expect(await store.recover()).toBe(0);
    expect((await store.runs(fixture.session.id))[0]?.status).toBe('cancelled');
    await lease.release();
    const next = await competing.acquireRuntime();
    await next.release();
    // A killed owner is reclaimed without cancelling live work under another owner.
    const child = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.prepare('INSERT INTO runtime_lease VALUES (1, ?, ?)').run(process.pid, 'crashed'); process.kill(process.pid, 'SIGKILL');`;
    await expect(
      promisify(execFile)(process.execPath, ['-e', child, fixture.path]),
    ).rejects.toThrow();
    const recovered = await store.acquireRuntime();
    expect(await store.recover()).toBe(0);
    await recovered.release();
  } finally {
    await fixture.dispose();
  }
});

test('migration accepts the canonical repository consent key and schema1 upgrades retained data', async () => {
  const fixture = await setup();
  try {
    const session = {
      ...fixture.session,
      target: {
        ...fixture.session.target,
        repository: createHash('sha256').update(fixture.root).digest('hex'),
      },
    };
    await createFileSessionStore(fixture.root).save(session);
    expect(await migrateFileHistory(fixture.root)).toEqual({ imported: 1, unchanged: 0 });
    const db = new DatabaseSync(fixture.path);
    db.exec(
      'DROP TABLE interactions; DROP TABLE finding_dispositions; DROP TABLE events; DROP TABLE session_snapshots; DROP TABLE runs; DROP TABLE runtime_lease; DROP TABLE imports; DELETE FROM migrations WHERE version > 1; PRAGMA user_version = 1;',
    );
    db.close();
    const store = createSqliteSessionStore(fixture.root);
    expect(await store.get(session.id)).toEqual(session);
    expect(await store.runs(session.id)).toEqual([{ ...session, runId: session.id }]);
    await store.save({ ...session, revision: 1, status: 'completed' });
    const nextRunId = randomUUID();
    await store.save({ ...session, revision: 2, runId: nextRunId });
    expect((await store.runs(session.id)).map((run) => run.runId)).toEqual([session.id, nextRunId]);
    expect((await store.runs(session.id))[0]?.context).toBeUndefined();
    expect((await store.events(session.id)).map((event) => event.type)).toContain(
      'snapshot.captured',
    );
  } finally {
    await fixture.dispose();
  }
});

test('JSON cutover guard rejects new/changed originals while import baselines survive deletion', async () => {
  const fixture = await setup();
  try {
    const store = createSqliteSessionStore(fixture.root);
    const file = createFileSessionStore(fixture.root);
    await file.save(fixture.session);
    await expect(store.assertHistoryMigrated()).rejects.toThrow('migrate-history');
    await migrateFileHistory(fixture.root);
    await store.assertHistoryMigrated();
    const lease = await store.acquireRuntime();
    await expect(migrateFileHistory(fixture.root)).rejects.toThrow('Stop');
    await lease.release();
    await store.save({
      ...fixture.session,
      revision: 1,
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    });
    await store.assertHistoryMigrated();
    expect(await migrateFileHistory(fixture.root)).toEqual({ imported: 0, unchanged: 1 });
    await store.delete(fixture.session.id, 1);
    await store.assertHistoryMigrated();
    expect(await migrateFileHistory(fixture.root)).toEqual({ imported: 0, unchanged: 1 });
    expect(await store.get(fixture.session.id)).toBeNull();
    await file.save({ ...fixture.session, revision: 1, status: 'running' });
    await expect(store.assertHistoryMigrated()).rejects.toThrow('migrate-history');
    await expect(migrateFileHistory(fixture.root)).rejects.toThrow('conflicts');
    expect(await store.get(fixture.session.id)).toBeNull();
  } finally {
    await fixture.dispose();
  }
});

test('historical finding dispositions survive reruns without rewriting the terminal result', async () => {
  const fixture = await setup();
  try {
    const store = createSqliteSessionStore(fixture.root);
    const first = { ...fixture.session, runId: randomUUID() };
    await store.save(first);
    const finding = {
      id: randomUUID(),
      file: 'example.ts',
      line: 1,
      side: 'new' as const,
      severity: 'major' as const,
      title: 'Review finding',
      explanation: 'Check the changed value',
      evidence: 'export const value = 2;',
      recommendation: 'Validate the value',
      status: 'open' as const,
      snapshotId: first.snapshot.id,
      policyHash: first.policy.hash,
      model: first.target.model,
      provider: first.target.provider,
      promptVersion: 'correctness-v1' as const,
      runId: first.runId,
    };
    const completed = {
      ...first,
      revision: 1,
      status: 'completed' as const,
      findings: [finding],
      completedAt: new Date().toISOString(),
    };
    await store.save(completed);
    await store.save({
      ...completed,
      revision: 2,
      findings: [{ ...finding, status: 'dismissed' }],
    });
    await store.save({ ...first, runId: randomUUID(), revision: 3 });
    expect(
      (await createSqliteSessionStore(fixture.root).runs(first.id))[0]?.findings[0]?.status,
    ).toBe('dismissed');
    const db = new DatabaseSync(fixture.path);
    try {
      const retained = db.prepare('SELECT data FROM runs WHERE id = ?').get(first.runId)?.data;
      expect(typeof retained === 'string' && JSON.parse(retained).findings[0].status).toBe('open');
      expect(
        db
          .prepare('SELECT actor,reason,revision FROM finding_dispositions WHERE finding_id = ?')
          .get(finding.id),
      ).toMatchObject({ actor: 'user', reason: 'Dismissed by user', revision: 2 });
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare('DELETE FROM snapshots WHERE id = ?').run(first.snapshot.id);
    } finally {
      db.close();
    }
    await expect(store.runs(first.id)).rejects.toThrow('immutable input');
  } finally {
    await fixture.dispose();
  }
});

test('retention compares instants and retains sessions exactly at the cutoff', async () => {
  const fixture = await setup();
  try {
    const store = createSqliteSessionStore(fixture.root);
    const session = { ...fixture.session, createdAt: '2026-10-14T00:00:00.000Z' };
    await store.save(session);
    await store.save({ ...session, revision: 1, status: 'completed' });
    expect(await store.prune({ before: '2026-10-14T00:00:00Z', keepLatest: 0 })).toBe(0);
    expect(await store.prune({ before: '2026-10-14T00:00:00.001Z', keepLatest: 0 })).toBe(1);
  } finally {
    await fixture.dispose();
  }
});

test('schema3 inline run migration preserves history and stores immutable input only by reference', async () => {
  const fixture = await setup();
  try {
    const store = createSqliteSessionStore(fixture.root);
    await store.save(fixture.session);
    const completed = { ...fixture.session, revision: 1, status: 'completed' as const };
    await store.save(completed);
    const db = new DatabaseSync(fixture.path);
    try {
      db.exec('DROP TRIGGER required_run_input_insert; DROP TRIGGER immutable_run_input;');
      db.prepare('UPDATE runs SET data = ?').run(JSON.stringify(completed));
      db.exec(
        'ALTER TABLE runs DROP COLUMN snapshot_id; ALTER TABLE runs DROP COLUMN policy_hash; DROP TABLE interactions; DELETE FROM migrations WHERE version >= 4; PRAGMA user_version = 3;',
      );
    } finally {
      db.close();
    }
    expect(await store.runs(fixture.session.id)).toEqual([{ ...completed, runId: completed.id }]);
    const check = new DatabaseSync(fixture.path);
    try {
      expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(9);
      const data = check.prepare('SELECT data FROM runs').get()?.data;
      expect(typeof data === 'string' && JSON.parse(data)).not.toHaveProperty('snapshot');
      expect(() => check.prepare('UPDATE runs SET snapshot_id = NULL').run()).toThrow('immutable');
    } finally {
      check.close();
    }
  } finally {
    await fixture.dispose();
  }
});

test('history saved under the pre-rename .reviewlab folder stays readable and writable in place', async () => {
  const fixture = await setup();
  try {
    const { root, session } = fixture;
    const service = (store = createSqliteSessionStore(root)) =>
      createReviewService({
        root,
        store,
        captureStaged: async () => session.snapshot,
        resolvePolicy: async () => session.policy,
        loadTarget: async () => session.target,
        agent: { review: async () => [] },
      });
    const created = await service().start();
    await rename(join(root, '.hunkyard'), join(root, '.reviewlab'));
    expect(await historyDatabasePath(root)).toBe(join(root, '.reviewlab', 'sqlite', 'history.db'));
    await service().execute(created.id);
    expect((await createSqliteSessionStore(root).get(created.id))?.status).toBe('completed');
    await expect(lstat(join(root, '.hunkyard', 'sqlite'))).rejects.toThrow('ENOENT');
  } finally {
    await fixture.dispose();
  }
});
