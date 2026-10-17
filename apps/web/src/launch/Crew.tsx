import {
  type AgentId,
  isHostedProvider,
  ProviderSchema,
  profileAgents,
  providerDefaults,
  type ReviewOptions,
  type ReviewPlan,
} from '@reviewlab/domain';
import { useState } from 'react';
import { agentMeta, profiles, providerMeta } from '../lib/meta';
import { Icon } from '../ui/Icon';
import { Avatar, Field, Switch } from '../ui/primitives';

type Props = {
  options: ReviewOptions;
  setOptions: (options: ReviewOptions) => void;
  plan: ReviewPlan | null;
  disabled?: boolean;
};

export const CrewPicker = ({ options, setOptions, disabled }: Props) => {
  const update = (patch: Partial<ReviewOptions>) => setOptions({ ...options, ...patch });
  return (
    <div className="crew">
      <div className="crew-profiles" role="radiogroup" aria-label="Review depth">
        {profiles.map((profile) => {
          const agents = profileAgents[profile.id];
          const on = options.profile === profile.id && !options.workflow;
          return (
            <button
              key={profile.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              className={`crew-card ${on ? 'is-on' : ''}`}
              onClick={() => update({ profile: profile.id })}
            >
              <span className="crew-stack">
                {agents.map((id, index) => (
                  <span key={id} style={{ zIndex: 10 - index }}>
                    <Avatar tint={agentMeta[id].tint} glyph={agentMeta[id].glyph} size={30} />
                  </span>
                ))}
              </span>
              <strong>{profile.name}</strong>
              <small>{profile.blurb}</small>
              <span className="crew-names">
                {agents.map((id) => agentMeta[id].name).join(' · ')}
              </span>
            </button>
          );
        })}
      </div>
      {options.workflow && (
        <p className="note">
          <Icon name="branch" size={14} /> A custom workflow from your saved settings is active; it
          decides which reviewers run.
        </p>
      )}
      <div className="crew-verifier">
        <Avatar tint="gray" glyph="V" size={30} />
        <Switch
          checked={options.verify}
          disabled={disabled}
          onChange={(verify) => update({ verify })}
          label="Add a verifier"
          hint="A second pass re-checks every finding before you see it. Fewer false alarms, a little slower."
        />
      </div>
    </div>
  );
};

/** Power-user knobs, tucked away: concurrency, budgets and per-reviewer model routing. */
export const CrewTuning = ({ options, setOptions, plan, disabled }: Props) => {
  const update = (patch: Partial<ReviewOptions>) => setOptions({ ...options, ...patch });
  const [open, setOpen] = useState<AgentId | null>(null);
  const omit = <K extends 'tokenBudget' | 'maxCostUsd'>(key: K, raw: string) => {
    const { [key]: _drop, ...rest } = options;
    setOptions(raw ? { ...options, [key]: Number(raw) } : (rest as ReviewOptions));
  };
  return (
    <div className="tuning">
      <div className="tuning-grid">
        <Field label="Reviewers at once" hint="1–8 in parallel">
          <input
            type="number"
            min={1}
            max={8}
            disabled={disabled}
            value={options.concurrency}
            onChange={(event) => update({ concurrency: Number(event.target.value) })}
          />
        </Field>
        <Field label="Retries per reviewer" hint="On transient errors">
          <input
            type="number"
            min={0}
            max={2}
            disabled={disabled}
            value={options.retries}
            onChange={(event) => update({ retries: Number(event.target.value) })}
          />
        </Field>
        <Field
          label="Token budget"
          hint={plan ? `Default ${plan.maxTokens.toLocaleString()}` : 'Profile default'}
        >
          <input
            type="number"
            min={512}
            max={4000000}
            placeholder="Default"
            disabled={disabled}
            value={options.tokenBudget ?? ''}
            onChange={(event) => omit('tokenBudget', event.target.value)}
          />
        </Field>
        <Field label="Cost cap (USD)" hint="Empty = no cap">
          <input
            type="number"
            min={0}
            step="any"
            placeholder="No cap"
            disabled={disabled}
            value={options.maxCostUsd ?? ''}
            onChange={(event) => omit('maxCostUsd', event.target.value)}
          />
        </Field>
        <Field label="Queue">
          <select
            disabled={disabled}
            value={options.priority}
            onChange={(event) =>
              update({ priority: event.target.value as ReviewOptions['priority'] })
            }
          >
            <option value="interactive">Interactive</option>
            <option value="background">Background</option>
          </select>
        </Field>
      </div>
      {plan && (
        <div className="routes">
          <div className="routes-title">Per-reviewer model routing</div>
          {plan.agents.map((route) => {
            const override = options.agentModels[route.id] ?? {};
            const provider = override.provider ?? route.target.provider;
            const set = (patch: Record<string, unknown>) =>
              update({
                agentModels: { ...options.agentModels, [route.id]: { ...override, ...patch } },
              });
            const expanded = open === route.id;
            return (
              <div key={route.id} className={`route ${expanded ? 'is-open' : ''}`}>
                <button
                  type="button"
                  className="route-head"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : route.id)}
                >
                  <Avatar
                    tint={agentMeta[route.id].tint}
                    glyph={agentMeta[route.id].glyph}
                    size={22}
                  />
                  <strong>{agentMeta[route.id].name}</strong>
                  <span className="route-target">
                    <Icon
                      name={isHostedProvider(route.target.provider) ? 'cloud' : 'lock'}
                      size={13}
                    />
                    {providerMeta[route.target.provider].name} · {route.target.model}
                  </span>
                  <Icon name="chevronDown" size={14} className="route-chevron" />
                </button>
                {expanded && (
                  <div className="route-body">
                    <Field label="Provider">
                      <select
                        disabled={disabled}
                        value={provider}
                        onChange={(event) => {
                          const next = ProviderSchema.parse(event.target.value);
                          set({ provider: next, endpoint: providerDefaults[next].endpoint });
                        }}
                      >
                        {ProviderSchema.options.map((id) => (
                          <option key={id} value={id}>
                            {providerMeta[id].name}{' '}
                            {providerMeta[id].hosted ? '(hosted)' : '(local)'}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Model">
                      <input
                        disabled={disabled}
                        value={override.model ?? route.target.model}
                        onChange={(event) => set({ model: event.target.value })}
                      />
                    </Field>
                    <Field label="Endpoint">
                      <input
                        disabled={disabled}
                        value={override.endpoint ?? route.target.endpoint}
                        onChange={(event) => set({ endpoint: event.target.value })}
                      />
                    </Field>
                    {isHostedProvider(route.target.provider) &&
                      (['inputPerMillion', 'outputPerMillion'] as const).map((field) => (
                        <Field
                          key={field}
                          label={
                            field === 'inputPerMillion'
                              ? 'Input $ / 1M tokens'
                              : 'Output $ / 1M tokens'
                          }
                        >
                          <input
                            type="number"
                            min={0}
                            step="any"
                            disabled={disabled}
                            value={options.prices[route.id]?.[field] ?? ''}
                            onChange={(event) =>
                              update({
                                prices: {
                                  ...options.prices,
                                  [route.id]: {
                                    inputPerMillion: options.prices[route.id]?.inputPerMillion ?? 0,
                                    outputPerMillion:
                                      options.prices[route.id]?.outputPerMillion ?? 0,
                                    [field]: Number(event.target.value),
                                  },
                                },
                              })
                            }
                          />
                        </Field>
                      ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/** Every distinct destination that will receive source code, shown before anything is sent. */
export const Destinations = ({ plan }: { plan: ReviewPlan }) => {
  const seen = new Map<
    string,
    { provider: ReviewPlan['agents'][number]['target']; agents: AgentId[] }
  >();
  for (const route of plan.agents) {
    const key = `${route.target.provider}|${route.target.endpoint}|${route.target.model}`;
    const entry = seen.get(key);
    if (entry) entry.agents.push(route.id);
    else seen.set(key, { provider: route.target, agents: [route.id] });
  }
  return (
    <ul className="destinations">
      {[...seen.values()].map(({ provider: target, agents }) => {
        const hosted = isHostedProvider(target.provider);
        const blocked = hosted && (target.privacy !== 'cloud-allowed' || !target.cloudConsent);
        return (
          <li
            key={`${target.endpoint}${target.model}`}
            className={hosted ? 'is-cloud' : 'is-local'}
          >
            <span className="dest-icon">
              <Icon name={hosted ? 'cloud' : 'lock'} />
            </span>
            <span className="dest-text">
              <strong>
                {providerMeta[target.provider].name} · {target.model || 'no model set'}
              </strong>
              <small>
                {target.endpoint} — {hosted ? 'leaves this machine' : 'stays on this machine'}
              </small>
            </span>
            <span className="dest-agents">
              {agents.map((id) => (
                <Avatar key={id} tint={agentMeta[id].tint} glyph={agentMeta[id].glyph} size={20} />
              ))}
            </span>
            {blocked && <span className="dest-warn">Needs cloud consent</span>}
          </li>
        );
      })}
    </ul>
  );
};
