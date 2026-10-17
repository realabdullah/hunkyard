import type { Finding, FindingStatus, Interaction } from '@reviewlab/domain';
export const effectiveStatus = (
  state: Interaction,
  runId: string,
  finding: Finding,
): FindingStatus =>
  [...state.transitions]
    .reverse()
    .find((entry) => entry.runId === runId && entry.findingId === finding.id)?.to ?? finding.status;
