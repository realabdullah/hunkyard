import {
  isHostedProvider,
  type ModelTarget,
  type Provider,
  ProviderSchema,
  providerDefaults,
} from '@hunkyard/domain';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { providerMeta } from '../lib/meta';
import { useWorkspace } from '../lib/workspace';
import { Icon } from '../ui/Icon';
import { Button, Dialog, Field, Pill } from '../ui/primitives';

type Draft = ModelTarget & { allowCloud: boolean };

export const SettingsView = () => {
  const { target } = useWorkspace();
  if (!target)
    return (
      <div className="review-loading">
        <span className="loader" />
      </div>
    );
  return (
    <SettingsForm
      key={`${target.repository}:${target.provider}:${target.model}:${target.privacy}`}
      target={target}
    />
  );
};

const SettingsForm = ({ target }: { target: ModelTarget }) => {
  const { act, busy, reload } = useWorkspace();
  const [draft, setDraft] = useState<Draft>({ ...target, allowCloud: target.cloudConsent });
  const [secret, setSecret] = useState('');
  const [probe, setProbe] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const hosted = isHostedProvider(draft.provider);
  const dirty =
    JSON.stringify({ ...target, allowCloud: target.cloudConsent }) !== JSON.stringify(draft);
  const pick = (provider: Provider) =>
    set({
      provider,
      endpoint: providerDefaults[provider].endpoint,
      model: providerDefaults[provider].model,
      allowCloud: false,
      structuredOutput: 'json',
    });
  const save = () =>
    act(async () => {
      const {
        allowCloud,
        cloudConsent: _consent,
        approvedHostedOrigins: _origins,
        repository: _repo,
        ...model
      } = draft;
      await api('/config', {
        method: 'POST',
        body: JSON.stringify({ model: { ...target, ...model }, allowCloud }),
      });
      await reload();
    }, 'Settings saved. Nothing has been sent anywhere.');
  const test = (capabilities: boolean) =>
    void act(async () => {
      setProbe(null);
      try {
        const result = await api<{
          ready: boolean;
          structuredOutput?: string;
          limitation?: string;
        }>(capabilities ? '/models/capabilities' : '/models/probe', { method: 'POST' });
        setProbe(
          result.ready
            ? {
                tone: 'ok',
                text: capabilities
                  ? `Structured output works: ${result.structuredOutput}. ${result.limitation ?? ''}`
                  : 'Connected — the model is ready.',
              }
            : { tone: 'warn', text: 'The endpoint answered, but this model isn’t listed there.' },
        );
      } catch (error) {
        setProbe({ tone: 'error', text: error instanceof Error ? error.message : 'Test failed' });
      }
    });
  const local = ProviderSchema.options.filter((id) => !providerMeta[id].hosted);
  const cloud = ProviderSchema.options.filter((id) => providerMeta[id].hosted);
  return (
    <div className="settings">
      <div className="settings-inner">
        <header className="settings-hero">
          <h1>Models & privacy</h1>
          <p className="lede">
            Pick who reads your code. Changes apply to new reviews only, and cloud consent applies
            to this repository alone.
          </p>
        </header>

        <section className="set-card" aria-labelledby="set-privacy">
          <h2 id="set-privacy">
            <Icon name="shield" /> Privacy
          </h2>
          <div className="privacy-choice" role="radiogroup" aria-label="Privacy">
            <button
              type="button"
              role="radio"
              aria-checked={draft.privacy === 'local-only'}
              className={`privacy-option ${draft.privacy === 'local-only' ? 'is-on' : ''}`}
              onClick={() => set({ privacy: 'local-only' })}
            >
              <span className="po-icon tint-green">
                <Icon name="lock" size={18} />
              </span>
              <strong>Local only</strong>
              <small>
                Hosted requests are technically blocked. Code never leaves this machine.
              </small>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={draft.privacy === 'cloud-allowed'}
              className={`privacy-option ${draft.privacy === 'cloud-allowed' ? 'is-on' : ''}`}
              onClick={() => set({ privacy: 'cloud-allowed' })}
            >
              <span className="po-icon tint-orange">
                <Icon name="cloud" size={18} />
              </span>
              <strong>Cloud allowed</strong>
              <small>
                Hosted models and GitHub can be used — only with explicit consent below.
              </small>
            </button>
          </div>
          <p className="muted small">
            Known secret patterns are redacted before any inference. No telemetry, no silent cloud
            fallback.
          </p>
        </section>

        <section className="set-card" aria-labelledby="set-model">
          <h2 id="set-model">
            <Icon name="sparkle" /> Model
          </h2>
          <div className="provider-group">
            <span className="group-label">
              <Icon name="lock" size={12} /> Runs on your machine
            </span>
            <div className="provider-grid">
              {local.map((id) => (
                <ProviderTile key={id} id={id} on={draft.provider === id} pick={pick} />
              ))}
            </div>
            <span className="group-label">
              <Icon name="cloud" size={12} /> Hosted
            </span>
            <div className="provider-grid">
              {cloud.map((id) => (
                <ProviderTile key={id} id={id} on={draft.provider === id} pick={pick} />
              ))}
            </div>
          </div>
          <div className="row-2">
            <Field label="Model">
              <input value={draft.model} onChange={(event) => set({ model: event.target.value })} />
            </Field>
            <Field
              label="Endpoint"
              hint={
                hosted ? 'Fixed HTTPS origin for this provider.' : 'Must be a loopback address.'
              }
            >
              <input
                value={draft.endpoint}
                onChange={(event) => set({ endpoint: event.target.value, allowCloud: false })}
              />
            </Field>
          </div>
          {hosted && (
            <label className={`consent ${draft.allowCloud ? 'is-on' : ''}`}>
              <input
                type="checkbox"
                checked={draft.allowCloud}
                onChange={(event) => set({ allowCloud: event.target.checked })}
              />
              <span>
                I authorize this repository’s selected Git diff, related source context and advisory
                rules to be sent to <strong>{providerMeta[draft.provider].name}</strong> at{' '}
                <code>{draft.endpoint}</code> when cloud mode is on.
                {draft.provider === 'agentrouter' &&
                  ' AgentRouter forwards requests to its upstream model providers.'}
              </span>
            </label>
          )}
          {hosted && draft.privacy === 'local-only' && (
            <p className="note is-warn">
              <Icon name="lock" size={13} /> You picked a hosted model but privacy is Local only —
              reviews will be blocked until you allow cloud.
            </p>
          )}
          <div className="test-row">
            <Button size="sm" disabled={busy || dirty} onClick={() => test(false)} icon="bolt">
              Test connection
            </Button>
            <Button size="sm" variant="ghost" disabled={busy || dirty} onClick={() => test(true)}>
              Test structured output
            </Button>
            {dirty && <small className="muted">Save first to test.</small>}
          </div>
          {probe && <p className={`note is-${probe.tone}`}>{probe.text}</p>}
          <p className="muted small">
            The structured-output test sends a tiny prompt (no code). Hosted tests may cost a
            fraction of a cent.
          </p>
        </section>

        <SecretCard provider={draft.provider} secret={secret} setSecret={setSecret} />

        <details className="set-card tuning-card">
          <summary>
            <h2>
              <Icon name="sliders" /> Fine tuning
            </h2>
            <span className="muted small">Temperature, budgets, timeouts</span>
          </summary>
          <div className="tuning-grid">
            <Field label="Structured output">
              <select
                value={draft.structuredOutput ?? 'json'}
                onChange={(event) =>
                  set({
                    structuredOutput: event.target.value as Draft['structuredOutput'] & string,
                  })
                }
              >
                <option value="json">JSON mode</option>
                <option value="schema" disabled={draft.provider === 'deepseek'}>
                  JSON schema (test first)
                </option>
                <option value="text">Plain text, validated as JSON</option>
              </select>
            </Field>
            {(
              [
                ['temperature', 'Temperature', 0, 2, 0.1, 0],
                ['topP', 'Top P', 0.01, 1, 0.01, 1],
                ['contextWindow', 'Context window hint', 1024, 2000000, 1, 128000],
                ['maxTokens', 'Output tokens per request', 256, 16000, 1, 4000],
                ['maxReviewTokens', 'Total review budget', 512, 4000000, 1, 400000],
                ['timeoutMs', 'Timeout (ms)', 100, 600000, 1, 120000],
                ['maxConcurrency', 'Concurrent reviews', 1, 8, 1, 1],
              ] as const
            ).map(([key, label, min, max, step, fallback]) => (
              <Field key={key} label={label}>
                <input
                  type="number"
                  min={min}
                  max={max}
                  step={step}
                  value={draft[key] ?? fallback}
                  onChange={(event) => set({ [key]: Number(event.target.value) })}
                />
              </Field>
            ))}
          </div>
          <p className="muted small">
            Budgets use a conservative UTF-8 byte bound. Source is never silently truncated; one
            repair request may use the remaining budget.
          </p>
        </details>

        <StorageCard />
      </div>
      {dirty && (
        <div className="save-bar">
          <span>
            <Icon name="sparkle" size={14} /> Unsaved changes
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDraft({ ...target, allowCloud: target.cloudConsent })}
          >
            Discard
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
            Save settings
          </Button>
        </div>
      )}
    </div>
  );
};

const ProviderTile = ({
  id,
  on,
  pick,
}: {
  id: Provider;
  on: boolean;
  pick: (id: Provider) => void;
}) => (
  <button
    type="button"
    className={`provider-tile ${on ? 'is-on' : ''}`}
    aria-pressed={on}
    onClick={() => pick(id)}
  >
    <span className="pt-mark">{providerMeta[id].name.slice(0, 1)}</span>
    <span>
      <strong>{providerMeta[id].name}</strong>
      <small>{providerMeta[id].blurb}</small>
    </span>
  </button>
);

const SecretCard = ({
  provider,
  secret,
  setSecret,
}: {
  provider: Provider;
  secret: string;
  setSecret: (value: string) => void;
}) => {
  const { act, busy } = useWorkspace();
  const store = (value: string | null) =>
    void act(
      async () => {
        await api('/config/secret', {
          method: 'POST',
          body: JSON.stringify({ provider, secret: value }),
        });
        setSecret('');
      },
      value === null ? 'Saved key removed' : 'Key saved privately',
    );
  return (
    <section className="set-card" aria-labelledby="set-key">
      <h2 id="set-key">
        <Icon name="key" /> API key for {providerMeta[provider].name}
      </h2>
      <p className="muted small">
        Stored by the local server outside your repository. The API never sends it back. Environment
        variables work too.
      </p>
      <div className="secret-row">
        <input
          type="password"
          autoComplete="new-password"
          placeholder="Paste key"
          aria-label="Provider secret"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
        />
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !secret}
          onClick={() => store(secret)}
        >
          Save key
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => store(null)}>
          Remove saved key
        </Button>
      </div>
    </section>
  );
};

const StorageCard = () => {
  const { act, busy, reload } = useWorkspace();
  const [usage, setUsage] = useState<{
    sessions: number;
    runs: number;
    snapshots: number;
    bytes: number;
  } | null>(null);
  const [before, setBefore] = useState('');
  const [keep, setKeep] = useState('10');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (busy) return;
    void api<NonNullable<typeof usage>>('/storage').then(setUsage, () => setUsage(null));
  }, [busy]);
  return (
    <section className="set-card" aria-labelledby="set-storage">
      <h2 id="set-storage">
        <Icon name="database" /> History & storage
      </h2>
      {usage && (
        <div className="stats">
          {(
            [
              ['Reviews', usage.sessions],
              ['Runs', usage.runs],
              ['Snapshots', usage.snapshots],
              ['On disk', `${(usage.bytes / 1024 / 1024).toFixed(1)} MB`],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="stat">
              <strong>{value}</strong>
              <small>{label}</small>
            </div>
          ))}
        </div>
      )}
      <p className="muted small">
        Everything is kept until you delete it. Cleanup always keeps your newest reviews and skips
        active ones.
      </p>
      <div className="row-2">
        <Field label="Delete reviews created before">
          <input
            type="datetime-local"
            value={before}
            onChange={(event) => setBefore(event.target.value)}
          />
        </Field>
        <Field label="Always keep the newest">
          <input
            type="number"
            min={0}
            step={1}
            value={keep}
            onChange={(event) => setKeep(event.target.value)}
          />
        </Field>
      </div>
      <Button
        size="sm"
        variant="ghost"
        icon="trash"
        disabled={busy || !before}
        onClick={() => setConfirm(true)}
      >
        Clean up history…
      </Button>
      {confirm && (
        <Dialog
          title="Clean up history?"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Keep history
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api('/retention', {
                      method: 'POST',
                      body: JSON.stringify({
                        before: new Date(before).toISOString(),
                        keepLatest: Number(keep),
                      }),
                    });
                    setConfirm(false);
                    await reload();
                  }, 'History cleaned up')
                }
              >
                Permanently clean up
              </Button>
            </>
          }
        >
          <p>
            Deletes reviews created before <strong>{new Date(before).toLocaleString()}</strong>,
            except the newest <strong>{keep}</strong>. Their findings and unreferenced snapshots go
            too. This can’t be undone.
          </p>
        </Dialog>
      )}
      <p className="muted small">
        <Pill tint="gray">Tip</Pill> Delete a single review from its board’s ••• menu.
      </p>
    </section>
  );
};
