import type { Finding } from '@reviewlab/domain';
import { effectiveStatus } from './finding-status';
import type { InteractionAccess } from './interaction-access';
import type { ReviewServiceDependencies } from './ports';
export const createReconciliation = (
  deps: ReviewServiceDependencies,
  access: InteractionAccess,
) => {
  const { serial, read, save } = access;
  return (id: string) =>
    serial(async () => {
      const history = await deps.store.runs?.(id);
      const latest = await deps.store.get(id);
      if (!history || !latest || latest.status !== 'completed' || history.length < 2) return;
      const previous = history[history.length - 2];
      if (!previous) return;
      const runId = latest.runId ?? latest.id;
      const previousRunId = previous.runId ?? previous.id;
      const state = await read(id);
      if (state.comparisons.some((entry) => entry.runId === runId)) return;
      const sourceContext = (session: typeof latest, finding: Finding) => {
        const change = session.snapshot.changes.find(
          (entry) => (finding.side === 'new' ? entry.newPath : entry.oldPath) === finding.file,
        );
        const oid = finding.side === 'new' ? change?.newOid : change?.oldOid;
        const text = session.snapshot.sources.find((entry) => entry.oid === oid)?.text;
        return text
          ?.split('\n')
          .slice(Math.max(0, finding.line - 2), finding.line + 1)
          .join('\n');
      };
      for (const old of previous.findings) {
        const context = sourceContext(previous, old);
        const candidates = latest.findings.filter(
          (entry) =>
            entry.file === old.file &&
            entry.side === old.side &&
            entry.title === old.title &&
            entry.evidence === old.evidence,
        );
        const matches = candidates.filter(
          (entry) => context !== undefined && sourceContext(latest, entry) === context,
        );
        const next = matches.length === 1 && candidates.length === 1 ? matches[0] : undefined;
        const status = effectiveStatus(state, previousRunId, old);
        const outcome = next
          ? status === 'fixed'
            ? 'reintroduced'
            : 'matched'
          : candidates.length
            ? 'uncertain'
            : 'stale';
        state.comparisons.push({
          runId,
          previousRunId,
          oldFindingId: old.id,
          ...(next ? { newFindingId: next.id } : {}),
          outcome,
          note: next
            ? 'Unique defect identity and surrounding frozen source match.'
            : 'No certain match. Absence does not prove a fix; inspect coverage and old evidence.',
        });
        if (
          next &&
          ['accepted', 'dismissed', 'investigating', 'fixed', 'reintroduced'].includes(status)
        )
          state.transitions.push({
            id: globalThis.crypto.randomUUID(),
            runId,
            snapshotId: latest.snapshot.id,
            findingId: next.id,
            from: next.status,
            to: status === 'fixed' ? 'reintroduced' : status,
            actor: 'system',
            note: 'Carried across a unique source-context match; original anchors retained.',
            createdAt: new Date().toISOString(),
          });
      }
      if (previous.findings.length) await save(state);
    });
};
