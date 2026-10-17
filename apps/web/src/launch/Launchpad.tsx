import {
  type CaptureRequest,
  CaptureRequestSchema,
  parsePullRequest,
  type ReviewSession,
} from '@reviewlab/domain';
import { useState } from 'react';
import { api } from '../api';
import { useHotkeys } from '../lib/hooks';
import { agentMeta, ago, isLive, scopeMeta, sessionTitle } from '../lib/meta';
import { useWorkspace } from '../lib/workspace';
import { Icon, type IconName } from '../ui/Icon';
import { Avatar, Button, Field, Kbd, Switch, useToast } from '../ui/primitives';
import { CrewPicker, CrewTuning, Destinations } from './Crew';
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
        return toast('GitHub access is off while ReviewLab is local-only.', 'error');
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
  return (
    <div className="launch">
      <div className="launch-inner">
        <header className="launch-hero">
          <p className="eyebrow">
            {greeting()}
            {name ? (
              <>
                {' '}
                · <strong>{name}</strong>
              </>
            ) : null}
          </p>
          <h1>What should we look at?</h1>
          <p className="lede">
            ReviewLab freezes your changes, hands them to a crew of AI reviewers, and lays every
            finding out on a board for you to triage. Nothing touches your files without your say.
          </p>
        </header>

        <section className="step" aria-labelledby="step-what">
          <div className="step-head">
            <span className="step-num">1</span>
            <h2 id="step-what">Pick the changes</h2>
          </div>
          <div className="source-grid" role="radiogroup" aria-label="Git scope">
            {sources.map((entry) => {
              const text = sourceText(entry.id);
              const on = source === entry.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`source-card ${on ? 'is-on' : ''}`}
                  onClick={() => setSource(entry.id)}
                >
                  <span className="source-icon">
                    <Icon name={entry.icon} size={18} />
                  </span>
                  <strong>{text.title}</strong>
                  <small>{text.blurb}</small>
                  {on && (
                    <span className="source-check">
                      <Icon name="check" size={12} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="source-options">
            {(source === 'unstaged' || source === 'working-tree') && (
              <Switch
                checked={untracked}
                onChange={setUntracked}
                label="Include new untracked files"
                hint="Ignored files always stay out."
              />
            )}
            {source === 'branch' && (
              <Field label="Compare against" hint="We review everything since the merge-base.">
                <input
                  value={base}
                  onChange={(event) => setBase(event.target.value)}
                  placeholder="main"
                />
              </Field>
            )}
            {source === 'commit-range' && (
              <div className="row-2">
                <Field label="From">
                  <input value={from} onChange={(event) => setFrom(event.target.value)} />
                </Field>
                <Field label="To">
                  <input value={to} onChange={(event) => setTo(event.target.value)} />
                </Field>
              </div>
            )}
            {source === 'github' && (
              <>
                <Field
                  label="PR number or link"
                  hint={
                    <>
                      Uses your <code>gh</code> login. The PR must belong to this checkout’s origin.
                    </>
                  }
                >
                  <input
                    value={pr}
                    onChange={(event) => setPr(event.target.value)}
                    placeholder="123 or https://github.com/owner/repo/pull/123"
                    disabled={githubBlocked}
                  />
                </Field>
                {githubBlocked ? (
                  <p className="note is-warn">
                    <Icon name="lock" size={14} /> GitHub is blocked while ReviewLab is local-only.{' '}
                    <button type="button" className="link" onClick={() => go({ kind: 'settings' })}>
                      Change privacy
                    </button>
                  </p>
                ) : (
                  <Switch
                    checked={githubConsent}
                    onChange={setGithubConsent}
                    label="Allow GitHub read access for this capture"
                    hint="GitHub sees the repo and PR number. PR text and code go only to the reviewers below."
                  />
                )}
              </>
            )}
            {source !== 'github' &&
              (narrow ? (
                <Field label="Only these paths" hint="Comma or newline separated. Globs work.">
                  <textarea
                    rows={2}
                    value={paths}
                    onChange={(event) => setPaths(event.target.value)}
                    placeholder="src/payments/**, README.md"
                  />
                </Field>
              ) : (
                <button type="button" className="link" onClick={() => setNarrow(true)}>
                  + Only review certain paths
                </button>
              ))}
          </div>
        </section>

        <section className="step" aria-labelledby="step-crew">
          <div className="step-head">
            <span className="step-num">2</span>
            <h2 id="step-crew">Choose your crew</h2>
            <button
              type="button"
              className="link step-aside"
              onClick={() => setTune(!tune)}
              aria-expanded={tune}
            >
              <Icon name="sliders" size={14} /> {tune ? 'Hide tuning' : 'Tune'}
            </button>
          </div>
          {options ? (
            <>
              <CrewPicker options={options} setOptions={setOptions} plan={draftPlan} />
              {tune && <CrewTuning options={options} setOptions={setOptions} plan={draftPlan} />}
            </>
          ) : (
            <div className="skeleton" style={{ height: 150 }} />
          )}
        </section>

        <section className="step" aria-labelledby="step-where">
          <div className="step-head">
            <span className="step-num">3</span>
            <h2 id="step-where">Where your code goes</h2>
            <button
              type="button"
              className="link step-aside"
              onClick={() => go({ kind: 'settings' })}
            >
              <Icon name="gear" size={14} /> Change model
            </button>
          </div>
          {draftPlan ? (
            <Destinations plan={draftPlan} />
          ) : (
            <div className="skeleton" style={{ height: 64 }} />
          )}
          {error && (
            <p className="note is-error" role="alert">
              <Icon name="flag" size={14} /> {error}
            </p>
          )}
        </section>

        {recent.length > 0 && (
          <section className="recent" aria-labelledby="recent-title">
            <h2 id="recent-title">Pick up where you left off</h2>
            <div className="recent-grid">
              {recent.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className="recent-card"
                  onClick={() => go({ kind: 'review', id: session.id })}
                >
                  <span className={`session-dot ${isLive(session.status) ? 'is-live' : ''}`} />
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

      <div className="launch-bar">
        <div className="launch-summary">
          <span className="launch-avatars">
            {crew.map((route) => (
              <Avatar
                key={route.id}
                tint={agentMeta[route.id].tint}
                glyph={agentMeta[route.id].glyph}
                size={24}
              />
            ))}
          </span>
          <span>
            <strong>{sourceText(source).title}</strong> · {crew.length || '…'} reviewer
            {crew.length === 1 ? '' : 's'} ·{' '}
            {local ? (
              <span className="ok">
                <Icon name="lock" size={13} /> stays on this machine
              </span>
            ) : (
              <span className="warn">
                <Icon name="cloud" size={13} /> cloud allowed
              </span>
            )}
          </span>
        </div>
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
      </div>
    </div>
  );
};
