import {
  excludedPath,
  type FindingDraft,
  ModelTargetSchema,
  profileAgents,
  profileTokenBudgets,
  type ReviewSession,
  validateFindings,
  validateTarget,
} from './index';

export const findingKey = (finding: FindingDraft) =>
  JSON.stringify([
    finding.file,
    finding.side,
    finding.line,
    finding.title.trim().toLowerCase().replace(/\s+/g, ' '),
    finding.evidence.trim(),
    finding.recommendation.trim().toLowerCase().replace(/\s+/g, ' '),
  ]);

export const cancelAgentStates = (session: ReviewSession) => {
  for (const result of session.orchestration?.agents ?? [])
    if (result.status === 'queued' || result.status === 'running') result.status = 'cancelled';
  if (session.orchestration) session.orchestration.usageComplete = false;
};
export const validateReviewProvenance = (session: ReviewSession) => {
  if (!session.plan) {
    if (
      session.orchestration ||
      session.findings.some((finding) => finding.attributions || finding.verified)
    )
      throw new Error('Specialist provenance requires a frozen review plan.');
    return;
  }
  const plan = session.plan;
  if (JSON.stringify(plan.baseTarget) !== JSON.stringify(session.target))
    throw new Error('Review plan base target mismatch.');
  if (
    plan.maxTokens !==
    Math.min(
      plan.baseTarget.maxReviewTokens ?? 400000,
      plan.options.tokenBudget ?? profileTokenBudgets[plan.options.profile],
    )
  )
    throw new Error('Review plan token budget mismatch.');
  if (
    plan.options.workflow &&
    plan.options.verify !== plan.options.workflow.nodes.some((node) => node.agent === 'verifier')
  )
    throw new Error('Workflow verifier provenance mismatch.');
  const expected = plan.options.workflow?.nodes.map((node) => node.agent) ?? [
    ...profileAgents[plan.options.profile],
    ...(plan.options.verify ? ['verifier' as const] : []),
  ];
  if (JSON.stringify(plan.agents.map((route) => route.id)) !== JSON.stringify(expected))
    throw new Error('Review plan agents do not match its profile.');
  for (const route of plan.agents) {
    validateTarget(route.target);
    const target = ModelTargetSchema.parse({
      ...plan.baseTarget,
      ...plan.options.agentModels[route.id],
      privacy: plan.baseTarget.privacy,
      cloudConsent: plan.baseTarget.cloudConsent,
      repository: plan.baseTarget.repository,
    });
    if (JSON.stringify(target) !== JSON.stringify(route.target))
      throw new Error('Review plan route provenance mismatch.');
  }
  const state = session.orchestration;
  if (session.status === 'completed' && !state)
    throw new Error('Successful specialist review is missing agent results.');
  if (state) {
    if (JSON.stringify(state.agents.map((entry) => entry.id)) !== JSON.stringify(expected))
      throw new Error('Agent results do not match frozen routes.');
    if (
      state.reservedTokens > plan.maxTokens ||
      (plan.options.maxCostUsd !== undefined && state.estimatedCostUsd > plan.options.maxCostUsd)
    )
      throw new Error('Persisted review exceeds its shared budget.');
    for (const result of state.agents) {
      validateFindings(session.snapshot, result.findings);
      if (
        session.context?.entries &&
        result.findings.some(
          (finding) =>
            !session.snapshot.changes.some(
              (change) =>
                (finding.side === 'old' ? change.oldPath : change.newPath) === finding.file &&
                session.context?.files.includes(change.newPath ?? change.oldPath ?? ''),
            ),
        )
      )
        throw new Error('Agent candidate references an omitted source.');
      if (result.findings.some((finding) => excludedPath(finding.file, session.policy.exclusions)))
        throw new Error('Agent candidate references an excluded source.');
    }
    if (
      session.status === 'completed' &&
      state.agents.some((entry) => entry.status !== 'completed')
    )
      throw new Error('Successful review has an incomplete agent.');
  }
  for (const finding of session.findings) {
    if (!finding.attributions || !state)
      throw new Error('Specialist finding is missing provenance.');
    if (
      new Set(finding.attributions.map((entry) => entry.agent)).size !== finding.attributions.length
    )
      throw new Error('Repeated agent attribution.');
    for (const attribution of finding.attributions)
      if (
        attribution.agent === 'verifier' ||
        !state.agents
          .find((entry) => entry.id === attribution.agent)
          ?.findings.some((candidate) => findingKey(candidate) === findingKey(finding))
      )
        throw new Error('Finding attribution has no matching validated candidate.');
    if (
      finding.verified !== undefined &&
      (!plan.options.verify ||
        !state.agents
          .find((entry) => entry.id === 'verifier')
          ?.findings.some((candidate) => findingKey(candidate) === findingKey(finding)))
    )
      throw new Error('Finding verification provenance mismatch.');
  }
};
