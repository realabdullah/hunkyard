import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { InteractionSchema } from '@hunkyard/domain';
import { createSqliteSessionStore } from './sqlite';
import { absent, getSession, withDatabase } from './sqlite-database';
import { readRun } from './sqlite-runs';

const verify = (db: DatabaseSync, root: string) => {
  if (db.prepare('PRAGMA user_version').get()?.user_version !== 9)
    throw new Error(
      'Recovery requires a schema 9 backup. Preserve older backups and use their matching release.',
    );
  if (
    db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
    db.prepare('PRAGMA foreign_key_check').all().length
  )
    throw new Error('Backup failed SQLite integrity checks.');
  for (const row of db.prepare('SELECT id FROM sessions').all()) {
    if (typeof row.id !== 'string') throw new Error('Invalid backup session.');
    const session = getSession(db, row.id);
    if (session?.snapshot.repoRoot !== root)
      throw new Error('Backup belongs to another repository path. Restore at the original path.');
  }
  for (const row of db.prepare('SELECT * FROM runs').all()) readRun(db, row);
  for (const row of db.prepare('SELECT data FROM interactions').all()) {
    if (typeof row.data !== 'string') throw new Error('Invalid backup interaction.');
    InteractionSchema.parse(JSON.parse(row.data));
  }
};
const safeFile = async (file: string) => {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error('Recovery files must be regular files without links.');
};

export const backupHistory = async (root: string, destination: string) => {
  const path = resolve(destination);
  const temporary = join(await realpath(dirname(path)), `.hunkyard-backup-${randomUUID()}`);
  try {
    await withDatabase(root, (db) => db.prepare('VACUUM INTO ?').run(temporary));
    const backup = new DatabaseSync(temporary);
    try {
      verify(backup, root);
      backup.exec('DELETE FROM runtime_lease; PRAGMA journal_mode = DELETE;');
    } finally {
      backup.close();
    }
    await chmod(temporary, 0o600);
    // Atomic exclusive publication: never follow or overwrite an existing destination.
    await link(temporary, path);
    return { path, includesSource: true, excludesProviderCredentials: true };
  } finally {
    await rm(temporary, { force: true });
  }
};

export const restoreHistory = async (root: string, source: string) => {
  await safeFile(source);
  const parent = join(root, '.hunkyard');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await lstat(parent)).isSymbolicLink()) throw new Error('Unsafe recovery directory.');
  const directory = join(parent, 'sqlite');
  try {
    await lstat(directory);
    throw new Error(
      'Restore requires absent .hunkyard/sqlite. Stop Hunkyard and move existing history aside first.',
    );
  } catch (error) {
    if (!absent(error)) throw error;
  }
  const staging = join(parent, `recovery-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const path = join(staging, 'history.db');
    await copyFile(source, path, constants.COPYFILE_EXCL);
    await chmod(path, 0o600);
    const db = new DatabaseSync(path);
    try {
      verify(db, root);
      db.exec('DELETE FROM runtime_lease; PRAGMA journal_mode = DELETE;');
    } finally {
      db.close();
    }
    // mkdir is exclusive: a concurrent server or restore cannot be overwritten.
    await mkdir(directory, { mode: 0o700 });
    await copyFile(path, join(directory, 'history.db'), constants.COPYFILE_EXCL);
    await chmod(join(directory, 'history.db'), 0o600);
    const store = createSqliteSessionStore(root);
    const lease = await store.acquireRuntime();
    try {
      return { restored: (await store.list()).length, interrupted: await store.recover() };
    } finally {
      await lease.release();
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};
