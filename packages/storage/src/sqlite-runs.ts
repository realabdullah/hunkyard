import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { type ReviewSession, SessionSchema } from '@hunkyard/domain';
import { validateSessionIntegrity } from './file-store';

export const readRun = (db: DatabaseSync, row: Record<string, SQLOutputValue>): ReviewSession => {
  const snapshot = db
    .prepare('SELECT data FROM snapshots WHERE id = ?')
    .get(row.snapshot_id ?? null)?.data;
  const policy = db
    .prepare('SELECT data FROM policies WHERE hash = ?')
    .get(row.policy_hash ?? null)?.data;
  if (typeof row.data !== 'string' || typeof snapshot !== 'string' || typeof policy !== 'string')
    throw new Error('Run immutable input is missing or modified.');
  const data = JSON.parse(row.data);
  if ('snapshot' in data || 'policy' in data)
    throw new Error('Run payload contains unexpected inline input.');
  const session = SessionSchema.parse({
    ...data,
    snapshot: JSON.parse(snapshot),
    policy: JSON.parse(policy),
  });
  validateSessionIntegrity(session);
  if (
    (session.runId ?? session.id) !== row.id ||
    session.id !== row.session_id ||
    session.snapshot.id !== row.snapshot_id ||
    session.policy.hash !== row.policy_hash ||
    !db
      .prepare('SELECT snapshot_id FROM session_snapshots WHERE session_id = ? AND snapshot_id = ?')
      .get(session.id, session.snapshot.id)
  )
    throw new Error('Run metadata disagrees with retained history.');
  return session;
};
