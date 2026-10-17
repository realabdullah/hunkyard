import type {
  AgentId,
  DomainEvent,
  Finding,
  FindingStatus,
  Interaction,
  ReviewSession,
} from '@hunkyard/domain';
import { createContext, useContext } from 'react';
import { api } from '../api';
import { runIdOf, statusOf } from '../lib/meta';

export type Selection =
  | { kind: 'finding'; id: string }
  | { kind: 'file'; path: string; anchor?: string }
  | { kind: 'agent'; id: AgentId }
  | { kind: 'evidence' }
  | { kind: 'pr' }
  | { kind: 'chat' }
  | { kind: 'activity' };

export type ReviewCtx = {
  session: ReviewSession;
  latest: ReviewSession;
  runs: ReviewSession[];
  interaction: Interaction | null;
  historical: boolean;
  events: DomainEvent[];
  selection: Selection | null;
  select: (selection: Selection | null) => void;
  refresh: () => Promise<void>;
  status: (finding: Finding) => FindingStatus;
};

export const ReviewContext = createContext<ReviewCtx | null>(null);
export const useReview = () => {
  const value = useContext(ReviewContext);
  if (!value) throw new Error('Review context missing');
  return value;
};

export const makeStatus =
  (interaction: Interaction | null, session: ReviewSession) => (finding: Finding) =>
    statusOf(interaction, runIdOf(session), finding);

/** Records a finding decision against the latest interaction revision. */
export const decide = async (
  session: ReviewSession,
  finding: Finding,
  status: FindingStatus,
  extra: { reason?: string; note?: string } = {},
) => {
  const current = await api<Interaction>(`/sessions/${session.id}/interaction`);
  await api(`/sessions/${session.id}/findings/${finding.id}/status`, {
    method: 'POST',
    body: JSON.stringify({
      revision: current.revision,
      runId: runIdOf(session),
      status,
      note: extra.note ?? '',
      ...(status === 'dismissed' ? { reason: extra.reason ?? 'false-positive' } : {}),
    }),
  });
};
