import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { type ReviewSession, SessionSchema } from '@reviewlab/domain';
import type { DurableEvent } from './durable-types';
import { readRun } from './sqlite-runs';

export const terminal = (session: ReviewSession) =>
  ['completed', 'failed', 'cancelled'].includes(session.status);
export const runKey = (session: ReviewSession) => session.runId ?? session.id;
const result = (session: ReviewSession) => {
  const { revision: _revision, state: _state, findings, ...data } = session;
  return JSON.stringify({
    ...data,
    findings: findings.map(({ status: _status, ...finding }) => finding),
  });
};
export const appendEvent = (
  db: DatabaseSync,
  session: ReviewSession,
  type: DurableEvent['type'],
  data: DurableEvent['data'] = {},
) => {
  const event = {
    version: 1,
    id: randomUUID(),
    sessionId: session.id,
    runId: runKey(session),
    type,
    createdAt: new Date().toISOString(),
    data,
  };
  const inserted = db
    .prepare('INSERT INTO events(session_id,data) VALUES (?, ?)')
    .run(session.id, JSON.stringify(event));
  return Number(inserted.lastInsertRowid);
};
export const journal = (
  db: DatabaseSync,
  session: ReviewSession,
  current: ReviewSession | null,
  legacyInline = false,
) => {
  const isNewRun = !current || runKey(current) !== runKey(session);
  if (!current) appendEvent(db, session, 'session.created');
  if (isNewRun) {
    appendEvent(db, session, 'snapshot.captured', { snapshotId: session.snapshot.id });
    if (session.context)
      appendEvent(db, session, 'context.resolved', { contextId: session.context.id });
    appendEvent(db, session, 'run.queued');
  }
  if (isNewRun || current?.status !== session.status) {
    if (session.status !== 'queued')
      appendEvent(
        db,
        session,
        session.status === 'running' ? 'run.started' : `run.${session.status}`,
      );
    if (session.status === 'running') appendEvent(db, session, 'agent.started');
  }
  for (const finding of session.findings) {
    const previous = current?.findings.find((entry) => entry.id === finding.id);
    if (!previous) appendEvent(db, session, 'finding.validated', { findingId: finding.id });
    else if (previous.status !== finding.status)
      appendEvent(db, session, 'finding.dismissed', {
        findingId: finding.id,
        status: finding.status,
      });
  }
  db.prepare('INSERT OR IGNORE INTO session_snapshots VALUES (?, ?)').run(
    session.id,
    session.snapshot.id,
  );
  const retainDispositions = () => {
    for (const finding of session.findings) {
      const previous = db
        .prepare('SELECT status FROM finding_dispositions WHERE run_id = ? AND finding_id = ?')
        .get(runKey(session), finding.id);
      if (!previous || previous.status !== finding.status)
        db.prepare(
          'INSERT INTO finding_dispositions VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id,finding_id) DO UPDATE SET status = excluded.status, actor = excluded.actor, changed_at = excluded.changed_at, reason = excluded.reason, revision = excluded.revision',
        ).run(
          runKey(session),
          finding.id,
          finding.status,
          finding.status === 'dismissed' ? 'user' : 'system',
          new Date().toISOString(),
          finding.status === 'dismissed' ? 'Dismissed by user' : 'Validated finding',
          session.revision,
        );
    }
  };
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runKey(session));
  if (run && typeof run.data === 'string') {
    const previous = legacyInline ? SessionSchema.parse(JSON.parse(run.data)) : readRun(db, run);
    if (previous.id !== session.id) throw new Error('Run ID belongs to another session.');
    if (terminal(previous)) {
      if (result(previous) !== result(session))
        throw new Error('Terminal run results are immutable.');
      retainDispositions();
      return;
    }
  }
  if (legacyInline)
    db.prepare(
      'INSERT INTO runs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
    ).run(runKey(session), session.id, JSON.stringify(session));
  else {
    const { snapshot, policy, ...data } = session;
    db.prepare(
      'INSERT INTO runs(id,session_id,data,snapshot_id,policy_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
    ).run(runKey(session), session.id, JSON.stringify(data), snapshot.id, policy.hash);
  }
  retainDispositions();
};
export const cleanup = (db: DatabaseSync) => {
  db.exec(
    `DELETE FROM snapshots WHERE id NOT IN (SELECT snapshot_id FROM session_snapshots); DELETE FROM policies WHERE hash NOT IN (SELECT policy_hash FROM sessions) AND hash NOT IN (SELECT policy_hash FROM runs)`,
  );
};
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
};
