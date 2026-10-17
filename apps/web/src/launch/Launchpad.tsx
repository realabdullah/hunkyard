import {
  type CaptureRequest,
  CaptureRequestSchema,
  parsePullRequest,
  profileAgents,
  type ReviewSession,
} from '@hunkyard/domain';
import { useState } from 'react';
import { api } from '../api';
import { useHotkeys } from '../lib/hooks';
import { agentMeta, ago, isLive, profiles, scopeMeta, sessionTitle } from '../lib/meta';
import { useWorkspace } from '../lib/workspace';
import { Icon, type IconName } from '../ui/Icon';
import { Avatar, Button, Field, Kbd, Switch, useToast } from '../ui/primitives';
import { CrewTuning } from './Crew';
import { FlightPlan } from './FlightPlan';
import { TokenPicker } from './TokenPicker';
import { usePlan } from './usePlan';

type Source = CaptureRequest['kind'] | 'github';
const sources: { id: Source; icon: IconName }[] = [
  { id: 'staged', icon: 'layers' },
  { id: 'unstaged', icon: 'file' },
  { id: 'working-tree', icon: 'board' },
  { id: 'branch', icon: 'branch' },
  { id: 'commit-range', icon: 'range' },
  { id: 'github', icon: 'github' },
];
const sourceText = (id: Source) =>
  id === 'github'
    ? { title: 'Pull request', blurb: 'A GitHub PR from this repo', short: 'PR' }
    : scopeMeta[id];

const greeting = () => {
  const hour = new Date().getHours();
  return hour < 5
    ? 'Burning the midnight oil'
    : hour < 12
      ? 'Good morning'
      : hour < 18
        ? 'Good afternoon'
        : 'Good evening';
};

export const Launchpad = () => {
  const { target, name, sessions, busy, act, go, reload } = useWorkspace();
  const toast = useToast();
  const { options, setOptions, plan, draftPlan, error, checking } = usePlan();
  const [source, setSource] = useState<Source>('staged');
  const [untracked, setUntracked] = useState(false);
  const [base, setBase] = useState('main');
  const [from, setFrom] = useState('HEAD~1');
  const [to, setTo] = useState('HEAD');
  const [paths, setPaths] = useState('');
  const [narrow, setNarrow] = useState(false);
  const [tune, setTune] = useState(false);
  const [pr, setPr] = useState('');
  const [githubConsent, setGithubConsent] = useState(false);
  const local = target?.privacy !== 'cloud-allowed';
  const githubBlocked = source === 'github' && local;
  const opened = (session: ReviewSession) => {
    go({ kind: 'review', id: session.id });
    void reload();
  };
  const start = () => {
    if (busy || !plan) return;
    if (source === 'github') {
      if (githubBlocked)
        return toast('GitHub access is off while Hunkyard is local-only.', 'error');
      if (!githubConsent) return toast('Allow GitHub read access for this capture first.', 'error');
      void act(async () => {
        const { repository } = await api<{ repository: string }>('/github/repository');
        const request = parsePullRequest(pr.trim(), repository);
        opened(
          await api<ReviewSession>('/github/reviews', {
            method: 'POST',
            body: JSON.stringify({ ...request, review: plan.options }),
          }),
        );
      });
      return;
    }
    const parsed = CaptureRequestSchema.safeParse({
      kind: source,
      includeUntracked: ['unstaged', 'working-tree'].includes(source) && untracked,
      paths: narrow
        ? paths
            .split(/[\n,]/)
            .map((path) => path.trim())
            .filter(Boolean)
        : [],
      ...(source === 'branch' ? { baseRef: base } : source === 'commit-range' ? { from, to } : {}),
    });
    if (!parsed.success) {
      toast(parsed.error.issues.map((issue) => issue.message).join('; '), 'error');
      return;
    }
    void act(async () => {
      opened(
        await api<ReviewSession>('/sessions', {
          method: 'POST',
          body: JSON.stringify({ scope: parsed.data, review: plan.options }),
        }),
      );
    });
  };
  useHotkeys({ 'mod+enter': start });
  const crew = draftPlan?.agents ?? [];
  const recent = sessions.slice(0, 4);
  const startLabel =
    source === 'github'
      ? 'Capture PR & review'
      : source === 'staged'
        ? 'Review staged changes'
        : 'Review selected scope';
  const profile = profiles.find((entry) => entry.id === options?.profile);
  const sourceOptions = sources.map((entry) => ({
    id: entry.id,
    label: sourceText(entry.id).title,
    hint: sourceText(entry.id).blurb,
    lead: <Icon name={entry.icon} size={16} />,
  }));
  const crewOptions = profiles.map((entry) => ({
    id: entry.id,
    label: `${entry.name} crew`,
    hint: entry.blurb,
    lead: (
      <span className="crew-stack">
        {profileAgents[entry.id].map((id) => (
          <Avatar key={id} tint={agentMeta[id].tint} glyph={agentMeta[id].glyph} size={20} />
        ))}
      </span>
    ),
  }));
  return (
    <div className="launch">
      <div className="launch-inner">
        <p className="eyebrow">
          {greeting()}
          {name ? (
            <>
              {' '}
              · <strong>{name}</strong>
            </>
          ) : null}
        </p>
        <h1 className="sr-only">New review</h1>
        <div className="sentence" role="group" aria-label="Describe the review">
          <span className="sentence-line">
            Review{' '}
            <TokenPicker
              label="Git scope"
              value={source}
              options={sourceOptions}
              onChange={setSource}
              display={sourceText(source).title.toLowerCase()}
            />
            {source === 'branch' && (
              <>
                {' '}
                against{' '}
                <InlineInput label="Base branch" value={base} onChange={setBase} width={7} />
              </>
            )}
            {source === 'commit-range' && (
              <>
                {' '}
                from <InlineInput label="From ref" value={from} onChange={setFrom} width={7} /> to{' '}
                <InlineInput label="To ref" value={to} onChange={setTo} width={5} />
              </>
            )}
            {source === 'github' && (
              <>
                {' '}
                <InlineInput
                  label="PR number or link"
                  value={pr}
                  onChange={setPr}
                  width={9}
                  placeholder="#123"
                  disabled={githubBlocked}
                />
              </>
            )}
          </span>
          <span className="sentence-line">
            with the{' '}
            {options ? (
              <TokenPicker
                label="Review depth"
                value={options.profile}
                options={crewOptions}
                onChange={(id) => setOptions({ ...options, profile: id })}
                display={`${profile?.name.toLowerCase() ?? 'custom'} crew`}
              />
            ) : (
              <span className="token is-loading">crew</span>
            )}
            {options && (
              <button
                type="button"
                className={`token token-toggle ${options.verify ? 'is-on' : ''}`}
                aria-pressed={options.verify}
                onClick={() => setOptions({ ...options, verify: !options.verify })}
                title="A second pass re-checks every finding before you see it."
              >
                <Icon name={options.verify ? 'shield' : 'plus'} size={15} />
                {options.verify ? 'verified' : 'verifier'}
              </button>
            )}
          </span>
          <span className="sentence-line sentence-dim">
            {local ? (
              <>
                and keep it <span className="sentence-safe">on this machine.</span>
              </>
            ) : (
              <>
                and allow <span className="sentence-cloud">cloud models.</span>
              </>
            )}
          </span>
        </div>

        <div className="modifiers">
          {(source === 'unstaged' || source === 'working-tree') && (
            <button
              type="button"
              className={`chip ${untracked ? 'is-on' : ''}`}
              aria-pressed={untracked}
              onClick={() => setUntracked(!untracked)}
            >
              <Icon name={untracked ? 'check' : 'plus'} size={13} /> Include untracked files
            </button>
          )}
          {source !== 'github' && (
            <button
              type="button"
              className={`chip ${narrow ? 'is-on' : ''}`}
              aria-expanded={narrow}
              onClick={() => setNarrow(!narrow)}
            >
              <Icon name="file" size={13} /> Only certain paths
            </button>
          )}
          <button
            type="button"
            className={`chip ${tune ? 'is-on' : ''}`}
            aria-expanded={tune}
            onClick={() => setTune(!tune)}
          >
            <Icon name="sliders" size={13} /> Tune crew & models
          </button>
          <button type="button" className="chip" onClick={() => go({ kind: 'settings' })}>
            <Icon name="gear" size={13} /> Change model
          </button>
        </div>

        {narrow && source !== 'github' && (
          <div className="launch-drawer">
            <Field label="Only these paths" hint="Comma or newline separated. Globs work.">
              <textarea
                rows={2}
                value={paths}
                onChange={(event) => setPaths(event.target.value)}
                placeholder="src/payments/**, README.md"
              />
            </Field>
          </div>
        )}
        {source === 'github' && (
          <div className="launch-drawer">
            {githubBlocked ? (
              <p className="note is-warn">
                <Icon name="lock" size={14} /> GitHub is blocked while Hunkyard is local-only.{' '}
                <button type="button" className="link" onClick={() => go({ kind: 'settings' })}>
                  Change privacy
                </button>
              </p>
            ) : (
              <Switch
                checked={githubConsent}
                onChange={setGithubConsent}
                label="Allow GitHub read access for this capture"
                hint={
                  <>
                    Uses your <code>gh</code> login. GitHub sees the repo and PR number. PR text and
                    code go only to the reviewers below.
                  </>
                }
              />
            )}
          </div>
        )}
        {tune && options && (
          <div className="launch-drawer">
            {options.workflow && (
              <p className="note">
                <Icon name="branch" size={14} /> A custom workflow from your saved settings is
                active; it decides which reviewers run.
              </p>
            )}
            <CrewTuning options={options} setOptions={setOptions} plan={draftPlan} />
          </div>
        )}

        <div className="launch-go">
          <Button
            variant="primary"
            size="lg"
            disabled={
              busy ||
              !plan ||
              checking ||
              (source === 'github' && (githubBlocked || !githubConsent || !pr.trim()))
            }
            onClick={start}
          >
            <Icon name="play" size={14} />
            {startLabel}
            <Kbd>⌘↵</Kbd>
          </Button>
          <span className="launch-hint">
            Nothing touches your files without your say. {crew.length || '…'} reviewer
            {crew.length === 1 ? '' : 's'} ready.
          </span>
        </div>
        {error && (
          <p className="note is-error" role="alert">
            <Icon name="flag" size={14} /> {error}
          </p>
        )}

        <section className="flight-wrap" aria-labelledby="flight-title">
          <h2 id="flight-title" className="kicker">
            Flight plan
          </h2>
          <FlightPlan plan={draftPlan} scope={sourceText(source).title} />
        </section>

        {recent.length > 0 && (
          <section className="recent" aria-labelledby="recent-title">
            <h2 id="recent-title" className="kicker">
              Pick up where you left off
            </h2>
            <div className="recent-grid">
              {recent.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className="recent-card"
                  onClick={() => go({ kind: 'review', id: session.id })}
                >
                  <span className="recent-thumb" aria-hidden="true">
                    {Array.from({ length: Math.min(12, session.findingCount ?? 0) }, (_, index) => (
                      <i
                        key={index}
                        style={{
                          left: `${14 + ((index * 37) % 72)}%`,
                          top: `${18 + ((index * 53) % 64)}%`,
                        }}
                      />
                    ))}
                    {isLive(session.status) && <span className="loader small" />}
                  </span>
                  <strong>{sessionTitle(session)}</strong>
                  <small>
                    {ago(session.createdAt)} · {session.findingCount ?? 0} findings ·{' '}
                    {session.status}
                  </small>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

const InlineInput = ({
  label,
  value,
  onChange,
  width,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  width: number;
  placeholder?: string;
  disabled?: boolean;
}) => (
  <input
    className="token-input"
    aria-label={label}
    value={value}
    placeholder={placeholder}
    disabled={disabled}
    spellCheck={false}
    style={{ width: `${Math.max(width, value.length + 1)}ch` }}
    onChange={(event) => onChange(event.target.value)}
  />
);
