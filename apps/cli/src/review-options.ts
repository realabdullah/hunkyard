import { AgentIdSchema, type ReviewOptions, ReviewOptionsSchema } from '@reviewlab/domain';

export const reviewOptionsFromArgs = (args: string[], defaults: ReviewOptions): ReviewOptions => {
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const json = value('--review-options');
  const overrides = json ? ReviewOptionsSchema.partial().parse(JSON.parse(json)) : {};
  const agentModels = { ...defaults.agentModels, ...overrides.agentModels };
  for (const [index, flag] of args.entries()) {
    if (flag !== '--agent-model') continue;
    const assignment = args[index + 1] ?? '';
    const split = assignment.indexOf('=');
    if (split < 1 || split === assignment.length - 1)
      throw new Error('Expected --agent-model AGENT=MODEL.');
    const id = AgentIdSchema.parse(assignment.slice(0, split));
    agentModels[id] = { ...agentModels[id], model: assignment.slice(split + 1) };
  }
  return ReviewOptionsSchema.parse({
    ...defaults,
    ...overrides,
    agentModels,
    ...(value('--profile') ? { profile: value('--profile') } : {}),
    ...(args.includes('--verify') ? { verify: true } : {}),
    ...(value('--agent-concurrency') ? { concurrency: Number(value('--agent-concurrency')) } : {}),
    ...(value('--retries') ? { retries: Number(value('--retries')) } : {}),
    ...(value('--priority') ? { priority: value('--priority') } : {}),
    ...(value('--token-budget') ? { tokenBudget: Number(value('--token-budget')) } : {}),
    ...(value('--max-cost-usd') ? { maxCostUsd: Number(value('--max-cost-usd')) } : {}),
  });
};
