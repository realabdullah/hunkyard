import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type ReviewSession, SessionSchema } from '@reviewlab/domain';
import { validateSessionIntegrity, validateSnapshot } from './file-store';
import { journal, runKey } from './sqlite-journal';

const schemaVersion = 9;
const schema = `
  CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
  CREATE TABLE snapshots (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
  CREATE TABLE policies (hash TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK(revision >= 0),
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
    policy_hash TEXT NOT NULL REFERENCES policies(hash),
    created_at TEXT NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data))
  ) STRICT;
  CREATE TRIGGER immutable_snapshot BEFORE UPDATE ON snapshots
    BEGIN SELECT RAISE(ABORT, 'An immutable snapshot cannot be replaced.'); END;
  CREATE TRIGGER immutable_policy BEFORE UPDATE ON policies
    BEGIN SELECT RAISE(ABORT, 'An immutable policy cannot be replaced.'); END;
  PRAGMA user_version = 1;
`;
const durableSchema = `
 CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
 CREATE TABLE session_snapshots (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, snapshot_id TEXT NOT NULL REFERENCES snapshots(id), PRIMARY KEY(session_id,snapshot_id)) STRICT;
 CREATE TABLE events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
 CREATE TABLE imports (session_id TEXT PRIMARY KEY, digest TEXT NOT NULL) STRICT;
 CREATE TABLE runtime_lease (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL) STRICT;
 PRAGMA user_version = 2;
`;
export const absent = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
const prepare = async (root: string) => {
  const parent = join(root, '.reviewlab');
  const dir = join(parent, 'sqlite');
  for (const path of [parent, dir]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Review storage directory must not be a symlink.');
  }
  await chmod(dir, 0o700);
  const path = join(dir, 'history.db');
  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.close();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error('Unsafe SQLite storage file.');
      await chmod(file, 0o600);
    } catch (error) {
      if (!absent(error) || file === path) throw error;
    }
  }
  return path;
};
export const transaction = <T>(db: DatabaseSync, operation: () => T): T => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};
export const withDatabase = async <T>(
  root: string,
  operation: (db: DatabaseSync) => T,
): Promise<T> => {
  const path = await prepare(root);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 100; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (typeof version !== 'number' || version > schemaVersion)
      throw new Error('Unsupported SQLite schema version; use a compatible ReviewLab version.');
    db.exec('PRAGMA journal_mode = WAL');
    if (version === 0) {
      transaction(db, () => {
        // Recheck after acquiring the writer lock: another process may have migrated first.
        if (db.prepare('PRAGMA user_version').get()?.user_version === 0) {
          if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get())
            throw new Error('Unrecognized SQLite database; preserve it for inspection.');
          db.exec(schema);
          db.prepare('INSERT INTO migrations VALUES (?, ?)').run(1, new Date().toISOString());
        }
      });
    }
    if (db.prepare('PRAGMA user_version').get()?.user_version === 1) {
      transaction(db, () => {
        if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) return;
        db.exec(durableSchema);
        db.prepare('INSERT INTO migrations VALUES (?, ?)').run(2, new Date().toISOString());
      });
    }
    if (db.prepare('PRAGMA user_version').get()?.user_version === 2) {
      transaction(db, () => {
        if (db.prepare('PRAGMA user_version').get()?.user_version !== 2) return;
        db.exec(`CREATE TABLE IF NOT EXISTS imports (session_id TEXT PRIMARY KEY, digest TEXT NOT NULL) STRICT;
          CREATE TABLE finding_dispositions (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, finding_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','dismissed')), actor TEXT NOT NULL, changed_at TEXT NOT NULL, reason TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), PRIMARY KEY(run_id,finding_id)) STRICT;`);
        for (const row of db.prepare('SELECT id FROM sessions').all()) {
          if (typeof row.id !== 'string') throw new Error('Invalid session ID.');
          const session = getSession(db, row.id);
          if (session && !db.prepare('SELECT id FROM runs WHERE id = ?').get(runKey(session)))
            journal(db, session, null, true);
        }
        for (const row of db.prepare('SELECT data FROM runs').all()) {
          if (typeof row.data !== 'string') throw new Error('Invalid run.');
          const run = SessionSchema.parse(JSON.parse(row.data));
          for (const finding of run.findings)
            db.prepare(
              'INSERT OR IGNORE INTO finding_dispositions VALUES (?, ?, ?, ?, ?, ?, ?)',
            ).run(
              runKey(run),
              finding.id,
              finding.status,
              finding.status === 'dismissed' ? 'user' : 'system',
              run.completedAt ?? run.createdAt,
              finding.status === 'dismissed' ? 'Dismissed by user' : 'Validated finding',
              run.revision,
            );
        }
        for (const row of db.prepare('SELECT id FROM sessions').all()) {
          if (typeof row.id !== 'string') throw new Error('Invalid session ID.');
          const session = getSession(db, row.id);
          if (session)
            for (const finding of session.findings)
              db.prepare(
                'UPDATE finding_dispositions SET status = ?, actor = ?, reason = ?, revision = ? WHERE run_id = ? AND finding_id = ?',
              ).run(
                finding.status,
                finding.status === 'dismissed' ? 'user' : 'system',
                finding.status === 'dismissed' ? 'Dismissed by user' : 'Validated finding',
                session.revision,
                runKey(session),
                finding.id,
              );
        }
        db.exec('PRAGMA user_version = 3');
        db.prepare('INSERT INTO migrations VALUES (?, ?)').run(3, new Date().toISOString());
      });
    }
    if (db.prepare('PRAGMA user_version').get()?.user_version === 3) {
      transaction(db, () => {
        if (db.prepare('PRAGMA user_version').get()?.user_version !== 3) return;
        for (const row of db.prepare('SELECT id,session_id,data FROM runs').all()) {
          if (typeof row.data !== 'string') throw new Error('Invalid legacy run.');
          const run = SessionSchema.parse(JSON.parse(row.data));
          validateSessionIntegrity(run);
          if (
            runKey(run) !== row.id ||
            run.id !== row.session_id ||
            db.prepare('SELECT data FROM snapshots WHERE id = ?').get(run.snapshot.id)?.data !==
              JSON.stringify(run.snapshot) ||
            db.prepare('SELECT data FROM policies WHERE hash = ?').get(run.policy.hash)?.data !==
              JSON.stringify(run.policy)
          )
            throw new Error('Legacy run immutable input is missing or modified.');
        }
        db.exec(`ALTER TABLE runs ADD COLUMN snapshot_id TEXT REFERENCES snapshots(id);
          ALTER TABLE runs ADD COLUMN policy_hash TEXT REFERENCES policies(hash);
          UPDATE runs SET snapshot_id = json_extract(data, '$.snapshot.id'), policy_hash = json_extract(data, '$.policy.hash'), data = json_remove(data, '$.snapshot', '$.policy');
          CREATE TRIGGER required_run_input_insert BEFORE INSERT ON runs WHEN NEW.snapshot_id IS NULL OR NEW.policy_hash IS NULL BEGIN SELECT RAISE(ABORT, 'Run input references are required.'); END;
          CREATE TRIGGER immutable_run_input BEFORE UPDATE OF snapshot_id,policy_hash ON runs WHEN NEW.snapshot_id IS NOT OLD.snapshot_id OR NEW.policy_hash IS NOT OLD.policy_hash BEGIN SELECT RAISE(ABORT, 'Run input references are immutable.'); END;
          PRAGMA user_version = 4;`);
        db.prepare('INSERT INTO migrations VALUES (?, ?)').run(4, new Date().toISOString());
      });
    }
    if (db.prepare('PRAGMA user_version').get()?.user_version === 4) {
      transaction(db, () => {
        if (db.prepare('PRAGMA user_version').get()?.user_version !== 4) return;
        db.exec(
          `CREATE TABLE interactions (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT; PRAGMA user_version = 5;`,
        );
        db.prepare('INSERT INTO migrations VALUES (?, ?)').run(5, new Date().toISOString());
      });
    }
    if (db.prepare('PRAGMA user_version').get()?.user_version === 5) {
      transaction(db, () => {
        if (db.prepare('PRAGMA user_version').get()?.user_version !== 5) return;
        // Require a reader that preserves PR provenance and publication receipts.
        db.exec('PRAGMA user_version = 6');
        db.prepare('INSERT INTO migrations VALUES (?, ?)').run(6, new Date().toISOString());
      });
    }
    if (db.prepare('PRAGMA user_version').get()?.user_version === 6) {
      transaction(db, () => {
        if (db.prepare('PRAGMA user_version').get()?.user_version !== 6) return;
        db.exec('PRAGMA user_version = 7');
        db.prepare('INSERT INTO migrations VALUES (?, ?)').run(7, new Date().toISOString());
      });
    }
    if (db.prepare('PRAGMA user_version').get()?.user_version === 7) {
      transaction(db, () => {
        if (db.prepare('PRAGMA user_version').get()?.user_version !== 7) return;
        db.exec('PRAGMA user_version = 8');
        db.prepare('INSERT INTO migrations VALUES (?, ?)').run(8, new Date().toISOString());
      });
    }
    if (db.prepare('PRAGMA user_version').get()?.user_version === 8) {
      transaction(db, () => {
        if (db.prepare('PRAGMA user_version').get()?.user_version !== 8) return;
        db.exec('PRAGMA user_version = 9');
        db.prepare('INSERT INTO migrations VALUES (?, ?)').run(9, new Date().toISOString());
      });
    }
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
      throw new Error('SQLite integrity check failed. Preserve the database for recovery.');
    const migration = db
      .prepare('SELECT version FROM migrations ORDER BY version DESC LIMIT 1')
      .get();
    if (migration?.version !== schemaVersion)
      throw new Error('SQLite migration history does not match its schema version.');
    return operation(db);
  } catch (error) {
    if (error instanceof Error && /database (?:is )?locked|database is busy/i.test(error.message))
      throw new Error('SQLite storage is busy; retry after the other writer finishes.');
    throw error;
  } finally {
    db.close();
  }
};
export const getSession = (db: DatabaseSync, id: string): ReviewSession | null => {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!row) return null;
  const snapshot = db
    .prepare('SELECT data FROM snapshots WHERE id = ?')
    .get(row.snapshot_id ?? null);
  const policy = db
    .prepare('SELECT data FROM policies WHERE hash = ?')
    .get(row.policy_hash ?? null);
  if (
    typeof row.data !== 'string' ||
    typeof snapshot?.data !== 'string' ||
    typeof policy?.data !== 'string'
  )
    throw new Error('Immutable snapshot or policy is missing; history cannot be verified.');
  const session = SessionSchema.parse({
    ...JSON.parse(row.data),
    snapshot: validateSnapshot(JSON.parse(snapshot.data)),
    policy: JSON.parse(policy.data),
  });
  validateSessionIntegrity(session);
  if (
    session.id !== row.id ||
    session.revision !== row.revision ||
    session.createdAt !== row.created_at ||
    session.snapshot.id !== row.snapshot_id ||
    session.policy.hash !== row.policy_hash
  )
    throw new Error('SQLite session metadata does not match its retained data.');
  return session;
};
const retain = (db: DatabaseSync, session: ReviewSession) => {
  const snapshot = JSON.stringify(session.snapshot);
  const policy = JSON.stringify(session.policy);
  const savedSnapshot = db
    .prepare('SELECT data FROM snapshots WHERE id = ?')
    .get(session.snapshot.id);
  const savedPolicy = db
    .prepare('SELECT data FROM policies WHERE hash = ?')
    .get(session.policy.hash);
  if (savedSnapshot && savedSnapshot.data !== snapshot)
    throw new Error('An immutable snapshot cannot be replaced.');
  if (savedPolicy && savedPolicy.data !== policy)
    throw new Error('An immutable policy cannot be replaced.');
  db.prepare('INSERT OR IGNORE INTO snapshots VALUES (?, ?)').run(session.snapshot.id, snapshot);
  db.prepare('INSERT OR IGNORE INTO policies VALUES (?, ?)').run(session.policy.hash, policy);
};
export const writeSession = (db: DatabaseSync, session: ReviewSession) => {
  retain(db, session);
  const { snapshot, policy, ...data } = session;
  db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, data = excluded.data, snapshot_id = excluded.snapshot_id, policy_hash = excluded.policy_hash`).run(
    session.id,
    session.revision,
    snapshot.id,
    policy.hash,
    session.createdAt,
    JSON.stringify(data),
  );
};
