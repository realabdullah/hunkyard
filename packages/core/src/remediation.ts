import {
  PatchApplySchema,
  PatchApprovalSchema,
  PatchRequestSchema,
  RuleDecisionSchema,
} from '@hunkyard/domain';
import type { InteractionAccess } from './interaction-access';
import type { ReviewServiceDependencies } from './ports';
export const createRemediationService = (
  deps: ReviewServiceDependencies,
  access: InteractionAccess,
) => {
  const { serial, writable, read, save, check, run } = access;
  return {
    propose: (id: string, raw: unknown) =>
      serial(async () => {
        writable();
        const input = PatchRequestSchema.parse(raw);
        const state = await read(id);
        check(state, input.revision);
        if (!deps.patch) throw new Error('Patch adapter unavailable.');
        const session = await run(id, input.runId);
        if (
          input.findingId &&
          !session.findings.some(
            (finding) => finding.id === input.findingId && finding.file === input.file,
          )
        )
          throw new Error('Patch finding must identify this file in the retained run.');
        const prepared = await deps.patch.prepare(session, input.file, input.replacement);
        state.patches.push({
          id: globalThis.crypto.randomUUID(),
          runId: input.runId,
          snapshotId: session.snapshot.id,
          file: input.file,
          ...(input.findingId ? { findingId: input.findingId } : {}),
          replacement: input.replacement,
          ...prepared,
          createdAt: new Date().toISOString(),
          status: 'proposed',
        });
        await save(state);
        return state;
      }),
    approve: (id: string, patchId: string, raw: unknown) =>
      serial(async () => {
        writable();
        const input = PatchApprovalSchema.parse(raw);
        const state = await read(id);
        check(state, input.revision);
        const proposal = state.patches.find((entry) => entry.id === patchId);
        if (!proposal || proposal.status !== 'proposed')
          throw new Error('Only a proposed patch can be approved.');
        proposal.status = 'approved';
        proposal.approvedAt = new Date().toISOString();
        proposal.approvalToken = globalThis.crypto.randomUUID();
        proposal.isolated = input.isolated;
        await save(state);
        return state;
      }),
    apply: (id: string, patchId: string, raw: unknown) =>
      serial(async () => {
        writable();
        const input = PatchApplySchema.parse(raw);
        const state = await read(id);
        check(state, input.revision);
        const proposal = state.patches.find((entry) => entry.id === patchId);
        if (
          !proposal ||
          proposal.status !== 'approved' ||
          proposal.approvalToken !== input.approvalToken
        )
          throw new Error('Patch application requires its unused explicit approval token.');
        if (!deps.patch) throw new Error('Patch adapter unavailable.');
        const session = await run(id, proposal.runId);
        const latest = await deps.store.get(id);
        if (latest && ['queued', 'running'].includes(latest.status))
          throw new Error('Wait for the active review before applying a patch.');
        proposal.status = 'applying';
        await save(state);
        try {
          const result = await deps.patch.apply(session, proposal, proposal.isolated ?? false);
          proposal.status = 'applied';
          proposal.destination = result.destination;
          proposal.backup = result.backup;
        } catch (error) {
          proposal.status = 'conflict';
          proposal.error = error instanceof Error ? error.message : 'Patch refused.';
        }
        delete proposal.approvalToken;
        await save(state);
        return state;
      }),
    patchEffects: async (id: string, patchId: string, isolated: boolean) => {
      const state = await read(id);
      const proposal = state.patches.find((entry) => entry.id === patchId);
      if (!proposal || !deps.patch) throw new Error('Patch not found.');
      return deps.patch.describe(await run(id, proposal.runId), proposal, isolated);
    },
    suggestRule: (id: string, revision: number) =>
      serial(async () => {
        writable();
        const state = await read(id);
        check(state, revision);
        const dismissed = state.transitions.filter(
          (entry) => entry.to === 'dismissed' && entry.reason === 'preference',
        );
        const ids = [...new Set(dismissed.map((entry) => entry.findingId))];
        if (ids.length < 2)
          throw new Error('Rule suggestions require at least two preference dismissals.');
        if (
          state.rules.some(
            (entry) => JSON.stringify(entry.sourceFindingIds) === JSON.stringify(ids),
          )
        )
          return state;
        state.rules.push({
          id: globalThis.crypto.randomUUID(),
          text: 'Do not report stylistic preferences as defects unless a repository rule explicitly requires them. Preserve correctness, security and accessibility findings.',
          sourceFindingIds: ids,
          status: 'suggested',
          createdAt: new Date().toISOString(),
        });
        await save(state);
        return state;
      }),
    decideRule: (id: string, ruleId: string, raw: unknown) =>
      serial(async () => {
        writable();
        const input = RuleDecisionSchema.parse(raw);
        const state = await read(id);
        check(state, input.revision);
        const rule = state.rules.find((entry) => entry.id === ruleId);
        if (!rule || rule.status !== 'suggested')
          throw new Error('Rule suggestion not found or already decided.');
        rule.status = input.decision;
        await save(state);
        return state;
      }),
  };
};
