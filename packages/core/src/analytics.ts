import type { BenchmarkReport, Interaction, ReviewSession } from '@hunkyard/domain';

export const recommendPresets = (report: BenchmarkReport) => {
  if (report.synthetic)
    return {
      recommendation: null,
      reason: 'Scripted results cannot support model recommendations.',
    };
  const candidates = report.rows.filter(
    (row) => row.status === 'completed' && !row.error && row.precision > 0 && row.recall > 0,
  );
  const ranked = candidates
    .map((row) => ({
      model: row.model,
      profile: row.profile,
      verify: row.verify,
      precision: row.precision,
      recall: row.recall,
      f1:
        row.precision + row.recall
          ? (2 * row.precision * row.recall) / (row.precision + row.recall)
          : 0,
      reservedTokens: row.reservedTokens,
    }))
    .sort(
      (a, b) =>
        b.f1 - a.f1 ||
        b.precision - a.precision ||
        a.reservedTokens - b.reservedTokens ||
        a.model.localeCompare(b.model),
    );
  return {
    recommendation: ranked[0] ?? null,
    ranked,
    reason:
      'Candidate for human evaluation on seeded fixtures only. No settings changed. Reserved tokens are budget reservations, not measured latency or cost.',
  };
};

export const effectivenessAnalytics = (
  items: { runs: ReviewSession[]; interaction: Interaction }[],
) => {
  const groups = new Map<
    string,
    {
      agent: string;
      provider: string;
      model: string;
      findings: number;
      accepted: number;
      fixed: number;
      falsePositive: number;
      otherDismissed: number;
      unjudged: number;
    }
  >();
  let runs = 0;
  for (const item of items) {
    for (const run of item.runs) {
      if (run.status !== 'completed') continue;
      runs++;
      for (const finding of run.findings) {
        const transition = item.interaction.transitions
          .filter(
            (entry) =>
              entry.actor === 'user' && entry.runId === run.runId && entry.findingId === finding.id,
          )
          .at(-1);
        const routes = finding.attributions?.map((entry) => ({
          agent: entry.agent,
          target: entry.target,
        })) ?? [{ agent: 'correctness', target: run.target }];
        for (const route of routes) {
          const key = JSON.stringify([route.agent, route.target.provider, route.target.model]);
          let group = groups.get(key);
          if (!group) {
            group = {
              agent: route.agent,
              provider: route.target.provider,
              model: route.target.model,
              findings: 0,
              accepted: 0,
              fixed: 0,
              falsePositive: 0,
              otherDismissed: 0,
              unjudged: 0,
            };
            groups.set(key, group);
          }
          group.findings++;
          if (transition?.to === 'accepted') group.accepted++;
          else if (transition?.to === 'fixed') group.fixed++;
          else if (transition?.to === 'dismissed' && transition.reason === 'false-positive')
            group.falsePositive++;
          else if (transition?.to === 'dismissed') group.otherDismissed++;
          else group.unjudged++;
        }
      }
    }
  }
  return {
    runs,
    groups: [...groups.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    caveat:
      'Local explicit user dispositions per completed run; unjudged and non-quality dismissals are separate. Reruns count separately. Multi-agent findings credit each contributor. This is not measured defect recall or causal effectiveness.',
  };
};
