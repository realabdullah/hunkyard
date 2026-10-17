import {
  excludedPath,
  type FindingDraft,
  findingKey,
  isHostedProvider,
  type ModelTarget,
  ModelTargetSchema,
  type Orchestration,
  profileAgents,
  profileTokenBudgets,
  ReviewOptionsSchema,
  ReviewOutputSchema,
  type ReviewPlan,
  type ReviewSession,
  validateFindings,
  validateTarget,
} from '@hunkyard/domain';
import type { ReviewAgent } from './ports';

export const createReviewPlan = (target: ModelTarget, options: unknown): ReviewPlan => {
  const parsed = ReviewOptionsSchema.parse(options);
  if (
    parsed.workflow &&
    parsed.verify !== parsed.workflow.nodes.some((node) => node.agent === 'verifier')
  )
    throw new Error('verify must match the workflow verifier node.');
  const ids = parsed.workflow?.nodes.map((node) => node.agent) ?? [
    ...profileAgents[parsed.profile],
    ...(parsed.verify ? ['verifier' as const] : []),
  ];
  const plan: ReviewPlan = {
    options: parsed,
    baseTarget: target,
    maxTokens: Math.min(
      target.maxReviewTokens ?? 400000,
      parsed.tokenBudget ?? profileTokenBudgets[parsed.profile],
    ),
    agents: ids.map((id) => ({
      id,
      target: ModelTargetSchema.parse({
        ...target,
        ...parsed.agentModels[id],
        privacy: target.privacy,
        cloudConsent: target.cloudConsent,
        repository: target.repository,
      }),
    })),
  };
  for (const route of plan.agents) validateTarget(route.target);
  return plan;
};

const severityRank: Record<FindingDraft['severity'], number> = {
  critical: 6,
  high: 5,
  major: 5,
  medium: 4,
  low: 3,
  minor: 3,
  info: 2,
};
type AttributedDraft = FindingDraft & {
  attributions: NonNullable<ReviewSession['findings'][number]['attributions']>;
  verified?: boolean;
};

export const runReviewPlan = async (input: {
  session: ReviewSession & { plan: ReviewPlan };
  agent: ReviewAgent;
  instructions: string[];
  signal: AbortSignal;
  authorize: (target: ModelTarget) => Promise<void>;
  changed: (state: Orchestration, message: string) => Promise<void>;
}): Promise<AttributedDraft[]> => {
  const { session, agent, signal } = input;
  const plan = session.plan;
  const state: Orchestration = {
    reservedTokens: 0,
    estimatedCostUsd: 0,
    reportedInputTokens: 0,
    reportedOutputTokens: 0,
    usageComplete: true,
    costComplete: true,
    agents: plan.agents.map(({ id }) => ({ id, status: 'queued', attempts: 0, findings: [] })),
  };
  const notify = (message: string) => input.changed(structuredClone(state), message);
  const findings = new Map<string, AttributedDraft>();
  const validate = (drafts: unknown) => {
    const valid = validateFindings(
      session.snapshot,
      ReviewOutputSchema.parse({ findings: drafts }).findings,
    );
    for (const finding of valid) {
      if (finding.severity === 'major') finding.severity = 'high';
      if (finding.severity === 'minor') finding.severity = 'low';
      if (excludedPath(finding.file, session.policy.exclusions))
        throw new Error('Model cited an excluded source.');
      if (
        session.context?.entries &&
        !session.snapshot.changes.some(
          (change) =>
            (finding.side === 'old' ? change.oldPath : change.newPath) === finding.file &&
            session.context?.files.includes(change.newPath ?? change.oldPath ?? ''),
        )
      )
        throw new Error('Model cited a source omitted by the context budget.');
    }
    return valid;
  };
  const run = async (route: ReviewPlan['agents'][number], candidates?: FindingDraft[]) => {
    const result = state.agents.find((entry) => entry.id === route.id);
    if (!result) throw new Error('Missing agent state.');
    try {
      signal.throwIfAborted();
      result.status = 'running';
      await notify(`${route.id}: started`);
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(route.target.timeoutMs)]);
      for (let attempt = 0; attempt <= plan.options.retries; attempt++) {
        deadline.throwIfAborted();
        result.attempts++;
        await input.authorize(route.target);
        try {
          const raw = await agent.review({
            ...(session.policy.plugin ? { plugin: session.policy.plugin } : {}),
            snapshot: session.snapshot,
            instructions: input.instructions,
            exclusions: session.policy.exclusions,
            target: route.target,
            signal: deadline,
            agentId: route.id,
            ...(session.context ? { context: session.context } : {}),
            ...(candidates ? { candidates } : {}),
            reserve: (tokens, output) => {
              deadline.throwIfAborted();
              const price = plan.options.prices[route.id];
              if (isHostedProvider(route.target.provider) && !price) state.costComplete = false;
              if (
                isHostedProvider(route.target.provider) &&
                plan.options.maxCostUsd !== undefined &&
                !price
              )
                throw new Error(
                  'A hosted cost cap requires explicit input/output pricing for every hosted agent.',
                );
              const cost =
                isHostedProvider(route.target.provider) && price
                  ? (tokens * price.inputPerMillion + output * price.outputPerMillion) / 1000000
                  : 0;
              if (state.reservedTokens + tokens + output > plan.maxTokens)
                throw new Error(
                  'Shared review token budget exhausted before another model request.',
                );
              if (
                plan.options.maxCostUsd !== undefined &&
                state.estimatedCostUsd + cost > plan.options.maxCostUsd
              )
                throw new Error(
                  'Shared review cost budget exhausted before another model request.',
                );
              state.reservedTokens += tokens + output;
              state.estimatedCostUsd += cost;
            },
            onUsage: (tokens, output) => {
              state.usageComplete &&= tokens !== undefined && output !== undefined;
              state.reportedInputTokens += tokens ?? 0;
              state.reportedOutputTokens += output ?? 0;
            },
            onProgress: async (progress) => {
              await notify(`${route.id}: ${progress.stage} (attempt ${progress.attempt})`);
            },
          });
          deadline.throwIfAborted();
          result.findings = validate(raw);
          if (
            candidates &&
            result.findings.some(
              (finding) =>
                !candidates.some(
                  (candidate) => JSON.stringify(candidate) === JSON.stringify(finding),
                ),
            )
          )
            throw new Error('Verifier changed or invented a candidate.');
          result.status = 'completed';
          await notify(`${route.id}: completed`);
          return result.findings;
        } catch (error) {
          if (
            attempt >= plan.options.retries ||
            deadline.aborted ||
            !(error instanceof Error) ||
            !/unavailable|HTTP (?:429|5\d\d)|interrupted/i.test(error.message)
          )
            throw error;
          state.usageComplete = false;
          await notify(`${route.id}: retry`);
        }
      }
      throw new Error('Agent retry limit reached.');
    } catch (error) {
      result.status = signal.aborted ? 'cancelled' : 'failed';
      state.usageComplete = false;
      result.error = signal.aborted
        ? 'Review cancelled.'
        : error instanceof Error
          ? error.message
          : 'Agent failed.';
      await notify(`${route.id}: ${result.status}`);
      return null;
    }
  };
  const routes = plan.agents.filter((route) => route.id !== 'verifier');
  const pending = new Map(routes.map((route) => [route.id, route]));
  await notify('Agents queued');
  while (pending.size && !signal.aborted) {
    const ready = [...pending.values()].filter((route) =>
      (plan.options.workflow?.nodes.find((node) => node.agent === route.id)?.after ?? []).every(
        (id) => state.agents.find((entry) => entry.id === id)?.status === 'completed',
      ),
    );
    if (!ready.length) break;
    const batch = ready.slice(0, plan.options.concurrency);
    for (const route of batch) pending.delete(route.id);
    await Promise.all(batch.map((route) => run(route)));
  }
  for (const route of routes) {
    for (const finding of state.agents.find((entry) => entry.id === route.id)?.findings ?? []) {
      const key = findingKey(finding);
      const previous = findings.get(key);
      const attribution = {
        agent: route.id,
        target: route.target,
        promptVersion: 'specialists-v1' as const,
      };
      if (!previous) findings.set(key, { ...finding, attributions: [attribution] });
      else {
        if (severityRank[finding.severity] > severityRank[previous.severity])
          previous.severity = finding.severity;
        if (!previous.attributions.some((entry) => entry.agent === route.id))
          previous.attributions.push(attribution);
      }
    }
  }
  // Make ordering independent of completion order; unrelated defects on one line stay separate.
  const merged = [...findings.values()].sort((a, b) => findingKey(a).localeCompare(findingKey(b)));
  const verifier = plan.agents.find((route) => route.id === 'verifier');
  let confirmed = merged;
  if (verifier && !signal.aborted && !state.agents.some((entry) => entry.status === 'failed')) {
    const candidates = merged.map(
      ({ attributions: _attributions, verified: _verified, ...finding }) => finding,
    );
    const accepted = candidates.length ? await run(verifier, candidates) : [];
    if (!candidates.length) {
      const result = state.agents.find((entry) => entry.id === 'verifier');
      if (result) result.status = 'completed';
      await notify('verifier: completed');
    }
    confirmed = merged
      .filter((finding) =>
        accepted?.some((candidate) => findingKey(candidate) === findingKey(finding)),
      )
      .map((finding) => ({ ...finding, verified: true }));
  }
  for (const entry of state.agents) if (entry.status === 'queued') entry.status = 'cancelled';
  await notify('Agents finished');
  signal.throwIfAborted();
  const failed = state.agents.find((entry) => entry.status === 'failed');
  if (failed) throw new Error(`${failed.id}: ${failed.error ?? 'Agent failed.'}`);
  return confirmed;
};
