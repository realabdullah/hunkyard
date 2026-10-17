import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  cancelAgentStates,
  DomainEventSchema,
  emptyInteraction,
  InteractionSchema,
  type ReviewSession,
  SessionSchema,
} from '@reviewlab/domain';
import type { DurableStore } from './durable-types';
import { createFileSessionStore, validateSessionIntegrity, validateSnapshot } from './file-store';
import { absent, getSession, transaction, withDatabase, writeSession } from './sqlite-database';
import { alive, appendEvent, cleanup, journal, runKey, terminal } from './sqlite-journal';
import { readRun } from './sqlite-runs';

export const createSqliteSessionStore = (root: string): DurableStore => {
  let leaseToken: string | undefined;
  const get = (id: string) => withDatabase(root, (db) => getSession(db, id));
  const list = () =>
    withDatabase(root, (db) =>
      db
        .prepare('SELECT id FROM sessions ORDER BY created_at DESC, id')
        .all()
        .map((row) => {
          if (typeof row.id !== 'string') throw new Error('Invalid persisted session ID.');
          const session = getSession(db, row.id);
          if (!session) throw new Error('Missing persisted session.');
          return session;
        }),
    );
  const save = async (input: ReviewSession) => {
    const session = SessionSchema.parse(input);
    validateSessionIntegrity(session);
    await withDatabase(root, (db) =>
      transaction(db, () => {
        const current = getSession(db, session.id);
        if ((current ? current.revision + 1 : 0) !== session.revision)
          throw new Error('Session revision conflict. Reload before changing it.');
        if (
          current &&
          (current.createdAt !== session.createdAt ||
            current.target.repository !== session.target.repository)
        )
          throw new Error('Session provenance is immutable.');
        if (
          current &&
          runKey(current) === runKey(session) &&
          (JSON.stringify(current.target) !== JSON.stringify(session.target) ||
            JSON.stringify(current.policy) !== JSON.stringify(session.policy) ||
            JSON.stringify(current.snapshot) !== JSON.stringify(session.snapshot) ||
            JSON.stringify(current.context) !== JSON.stringify(session.context) ||
            JSON.stringify(current.plan) !== JSON.stringify(session.plan))
        )
          throw new Error('Run input is immutable.');
        if (current && runKey(current) !== runKey(session) && !terminal(current))
          throw new Error('Finish or cancel the current run before starting another.');
        writeSession(db, session);
        journal(db, session, current);
      }),
    );
  };
  const runs = (id: string) =>
    withDatabase(root, (db) =>
      db
        .prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY rowid')
        .all(id)
        .map((row) => {
          const session = readRun(db, row);
          const dispositions = db
            .prepare('SELECT finding_id,status FROM finding_dispositions WHERE run_id = ?')
            .all(runKey(session));
          return {
            ...session,
            runId: runKey(session),
            findings: session.findings.map((finding): ReviewSession['findings'][number] => {
              const disposition = dispositions.find((entry) => entry.finding_id === finding.id);
              if (
                !disposition ||
                (disposition.status !== 'open' && disposition.status !== 'dismissed')
              )
                throw new Error('Finding disposition is missing or invalid.');
              return { ...finding, status: disposition.status };
            }),
          };
        }),
    );
  const remove = (db: DatabaseSync, id: string, revision: number) => {
    const current = getSession(db, id);
    if (!current) return false;
    if (current.revision !== revision)
      throw new Error('Session revision conflict. Reload before deleting it.');
    if (!terminal(current)) throw new Error('Active sessions cannot be deleted.');
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    cleanup(db);
    return true;
  };
  return {
    get,
    interaction: (id) =>
      withDatabase(root, (db) => {
        if (!getSession(db, id)) throw new Error('Session not found.');
        const row = db
          .prepare('SELECT revision,data FROM interactions WHERE session_id = ?')
          .get(id);
        if (typeof row?.data !== 'string') return emptyInteraction(id);
        const state = InteractionSchema.parse(JSON.parse(row.data));
        if (state.sessionId !== id || state.revision !== row.revision)
          throw new Error('Interaction metadata does not match its retained data.');
        return state;
      }),
    saveInteraction: (input, expected) =>
      withDatabase(root, (db) =>
        transaction(db, () => {
          const state = InteractionSchema.parse(input);
          if (!getSession(db, state.sessionId)) throw new Error('Session not found.');
          const row = db
            .prepare('SELECT revision FROM interactions WHERE session_id = ?')
            .get(state.sessionId);
          if ((row?.revision ?? 0) !== expected || state.revision !== expected + 1)
            throw new Error('Interaction revision conflict. Reload before changing it.');
          db.prepare(
            'INSERT INTO interactions VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision, data = excluded.data',
          ).run(state.sessionId, state.revision, JSON.stringify(state));
        }),
      ),
    assertHistoryMigrated: async () => {
      const sources = await sourceHistory(root);
      if (!sources.length) return;
      await withDatabase(root, (db) => {
        for (const { session, digest } of sources) {
          if (
            db.prepare('SELECT digest FROM imports WHERE session_id = ?').get(session.id)
              ?.digest !== digest
          )
            throw new Error(
              'JSON history has not been migrated or changed since migration. Run migrate-history before opening ReviewLab.',
            );
        }
      });
    },
    list,
    save,
    runs,
    snapshots: (id) =>
      withDatabase(root, (db) =>
        db
          .prepare(
            'SELECT data FROM snapshots JOIN session_snapshots ON snapshots.id = session_snapshots.snapshot_id WHERE session_id = ? ORDER BY snapshots.rowid',
          )
          .all(id)
          .map((row) => {
            if (typeof row.data !== 'string') throw new Error('Invalid snapshot.');
            return validateSnapshot(JSON.parse(row.data));
          }),
      ),
    events: (id, after = 0) =>
      withDatabase(root, (db) =>
        db
          .prepare(
            'SELECT cursor,data FROM events WHERE session_id = ? AND cursor > ? ORDER BY cursor',
          )
          .all(id, after)
          .map((row) => {
            if (typeof row.data !== 'string' || typeof row.cursor !== 'number')
              throw new Error('Invalid durable event.');
            return DomainEventSchema.parse({ ...JSON.parse(row.data), cursor: row.cursor });
          }),
      ),
    progress: (id, runId, message) =>
      withDatabase(root, (db) =>
        transaction(db, () => {
          const session = getSession(db, id);
          if (!session || runKey(session) !== runId || session.status !== 'running')
            throw new Error('Progress requires the active running review.');
          // Provider messages are untrusted: retain only bounded generic phase text.
          appendEvent(db, session, 'agent.progress', {
            message:
              message === 'Reviewing staged changes' ||
              /^(?:(?:correctness|security|frontend|architecture|testing|verifier): (?:started|completed|failed|cancelled|retry|(?:request|response|repair) \(attempt [12]\))|Agents (?:queued|finished)|(?:request|response|repair) \(attempt [12]\))$/.test(
                message,
              )
                ? message
                : 'Review in progress',
          });
        }),
      ),
    acquireRuntime: async () => {
      const token = randomUUID();
      await withDatabase(root, (db) =>
        transaction(db, () => {
          const owner = db.prepare('SELECT pid FROM runtime_lease WHERE id = 1').get();
          if (typeof owner?.pid === 'number' && alive(owner.pid))
            throw new Error(
              'Another ReviewLab runtime owns this repository. Stop it before opening another runtime.',
            );
          db.prepare(
            'INSERT INTO runtime_lease VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, token = excluded.token',
          ).run(process.pid, token);
        }),
      );
      leaseToken = token;
      return {
        release: async () => {
          await withDatabase(root, (db) => {
            db.prepare('DELETE FROM runtime_lease WHERE token = ?').run(token);
          });
          if (leaseToken === token) leaseToken = undefined;
        },
      };
    },
    recover: () =>
      withDatabase(root, (db) =>
        transaction(db, () => {
          const owner = db.prepare('SELECT token FROM runtime_lease WHERE id = 1').get();
          if (!leaseToken || owner?.token !== leaseToken)
            throw new Error('Crash recovery requires exclusive runtime ownership.');
          let count = 0;
          for (const row of db.prepare('SELECT id FROM sessions').all()) {
            if (typeof row.id !== 'string') throw new Error('Invalid session ID.');
            const current = getSession(db, row.id);
            if (!current || terminal(current)) continue;
            const session = SessionSchema.parse({
              ...current,
              revision: current.revision + 1,
              status: 'cancelled',
              state: 'interactive',
              completedAt: new Date().toISOString(),
              error: 'Review interrupted by runtime shutdown. Start a new run to retry.',
            });
            cancelAgentStates(session);
            writeSession(db, session);
            journal(db, session, current);
            count++;
          }
          return count;
        }),
      ),
    delete: (id, revision) =>
      withDatabase(root, (db) => transaction(db, () => remove(db, id, revision))),
    prune: async ({ before, keepLatest }) => {
      if (!Number.isInteger(keepLatest) || keepLatest < 0 || !Number.isFinite(Date.parse(before)))
        throw new Error('Invalid retention policy.');
      return withDatabase(root, (db) =>
        transaction(db, () => {
          const rows = db
            .prepare('SELECT id,revision,created_at FROM sessions ORDER BY created_at DESC,id')
            .all();
          let count = 0;
          for (const row of rows.slice(keepLatest)) {
            if (
              typeof row.id !== 'string' ||
              typeof row.revision !== 'number' ||
              typeof row.created_at !== 'string'
            )
              throw new Error('Invalid session metadata.');
            const current = getSession(db, row.id);
            if (
              Date.parse(row.created_at) < Date.parse(before) &&
              current &&
              terminal(current) &&
              remove(db, row.id, row.revision)
            )
              count++;
          }
          return count;
        }),
      );
    },
    usage: () =>
      withDatabase(root, (db) => ({
        sessions: Number(db.prepare('SELECT count(*) AS n FROM sessions').get()?.n),
        runs: Number(db.prepare('SELECT count(*) AS n FROM runs').get()?.n),
        snapshots: Number(db.prepare('SELECT count(*) AS n FROM snapshots').get()?.n),
        bytes:
          Number(db.prepare('PRAGMA page_count').get()?.page_count) *
          Number(db.prepare('PRAGMA page_size').get()?.page_size),
      })),
    export: async (id, redact = true) => {
      const history = await runs(id);
      if (!history.length) throw new Error('Session not found.');
      if (!redact)
        return {
          version: 1,
          redacted: false,
          session: await get(id),
          runs: history,
          interaction: await withDatabase(root, (db) => {
            const row = db
              .prepare('SELECT revision,data FROM interactions WHERE session_id = ?')
              .get(id);
            return typeof row?.data === 'string'
              ? InteractionSchema.parse(JSON.parse(row.data))
              : emptyInteraction(id);
          }),
        };
      return {
        version: 1,
        redacted: true,
        sessionId: id,
        runs: history.map((run) => ({
          id: runKey(run),
          status: run.status,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
          snapshotId: run.snapshot.id,
          fileCount: run.snapshot.files.length,
          findingCount: run.findings.length,
          provider: run.target.provider,
          privacy: run.target.privacy,
        })),
      };
    },
  };
};

const sourceHistory = async (root: string) => {
  // Validate every source record before opening the destination. Never modify/delete inputs.
  let files: string[];
  try {
    const source = join(root, '.reviewlab', 'sessions-v2');
    const stat = await lstat(source);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('History directory must not be a symlink.');
    files = await readdir(source);
  } catch (error) {
    if (!absent(error)) throw error;
    files = [];
  }
  if (files.some((file) => file.endsWith('.json') && !/^[0-9a-f-]{36}\.json$/i.test(file)))
    throw new Error('Unrecognized JSON history filename; inspect it before migration.');
  if (files.some((file) => file.endsWith('.lock')))
    throw new Error(
      'JSON history has a writer lock; stop writers and inspect stale locks before migration.',
    );
  const sessions = files.length ? await createFileSessionStore(root).list() : [];
  return sessions.map((session) => ({
    session,
    digest: createHash('sha256').update(JSON.stringify(session)).digest('hex'),
  }));
};

export const migrateFileHistory = async (
  root: string,
): Promise<{ imported: number; unchanged: number }> => {
  root = await realpath(root);
  const sources = await sourceHistory(root);
  return withDatabase(root, (db) =>
    transaction(db, () => {
      let imported = 0;
      let unchanged = 0;
      const owner = db.prepare('SELECT pid FROM runtime_lease WHERE id = 1').get();
      if (typeof owner?.pid === 'number' && alive(owner.pid))
        throw new Error('Stop the running ReviewLab runtime before migrating history.');
      for (const { session, digest } of sources) {
        if (
          session.snapshot.repoRoot !== root ||
          ![root, createHash('sha256').update(root).digest('hex')].includes(
            session.target.repository,
          )
        )
          throw new Error(
            'History belongs to another repository; repository move migration is not supported yet.',
          );
        const importedDigest = db
          .prepare('SELECT digest FROM imports WHERE session_id = ?')
          .get(session.id)?.digest;
        if (importedDigest === digest) {
          unchanged++;
          continue;
        }
        if (importedDigest)
          throw new Error(
            'Migration conflicts with previously imported JSON history. Neither copy was overwritten.',
          );
        const current = getSession(db, session.id);
        if (current) {
          if (JSON.stringify(current) !== JSON.stringify(session))
            throw new Error(
              'Migration conflicts with SQLite history. Neither copy was overwritten.',
            );
          unchanged += 1;
        } else {
          writeSession(db, session);
          journal(db, session, null);
          imported += 1;
        }
        db.prepare('INSERT INTO imports VALUES (?, ?)').run(session.id, digest);
      }
      return { imported, unchanged };
    }),
  );
};

export type { DurableStore } from './durable-types';
