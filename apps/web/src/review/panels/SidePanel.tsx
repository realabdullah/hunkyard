import { findingKey } from '@reviewlab/domain';
import { lazy, Suspense, useState } from 'react';
import { api } from '../../api';
import { diffStats } from '../../diff-lines';
import { useStoredState } from '../../lib/hooks';
import {
  agentMeta,
  dirName,
  fileName,
  providerMeta,
  runIdOf,
  severityMeta,
  sortFindings,
  statusMeta,
} from '../../lib/meta';
import { useWorkspace } from '../../lib/workspace';
import { Icon } from '../../ui/Icon';
import { Avatar, Button, IconButton, Pill } from '../../ui/primitives';
import { useReview } from '../context';
import { DiffView } from '../DiffView';
import { FindingDetail } from '../FindingDetail';
import { EvidencePanel } from './Evidence';
import { PatchFlow } from './PatchFlow';
import { PullRequestPanel } from './PullRequestPanel';
import { Thread } from './Thread';

const CodeEditor = lazy(() =>
  import('../../CodeEditor').then((module) => ({ default: module.CodeEditor })),
);

export const SidePanel = () => {
  const { selection, select, session } = useReview();
  const [wide, setWide] = useStoredState('reviewlab.panelWide', false);
  if (!selection) return null;
  const finding =
    selection.kind === 'finding'
      ? session.findings.find((entry) => entry.id === selection.id)
      : undefined;
  const title =
    selection.kind === 'finding'
      ? 'Finding'
      : selection.kind === 'file'
        ? 'File'
        : selection.kind === 'agent'
          ? 'Reviewer'
          : selection.kind === 'evidence'
            ? 'Evidence & provenance'
            : selection.kind === 'pr'
              ? 'Pull request'
              : selection.kind === 'chat'
                ? 'Discussion'
                : 'Activity';
  return (
    <aside className={`side-panel ${wide ? 'is-wide' : ''}`} aria-label={title}>
      <header className="panel-head">
        <span className="panel-title">{title}</span>
        <IconButton
          icon={wide ? 'arrowRight' : 'arrowLeft'}
          label={wide ? 'Narrow panel' : 'Widen panel'}
          onClick={() => setWide(!wide)}
        />
        <IconButton icon="close" label="Close panel (Esc)" onClick={() => select(null)} />
      </header>
      <div className="panel-body no-canvas-scroll">
        {finding && <FindingDetail key={finding.id} finding={finding} />}
        {selection.kind === 'file' && (
          <FilePanel key={selection.path} path={selection.path} anchor={selection.anchor ?? null} />
        )}
        {selection.kind === 'agent' && <AgentPanel id={selection.id} />}
        {selection.kind === 'evidence' && <EvidencePanel />}
        {selection.kind === 'pr' && <PullRequestPanel />}
        {selection.kind === 'chat' && <ChatPanel />}
        {selection.kind === 'activity' && <ActivityPanel />}
      </div>
    </aside>
  );
};

const FilePanel = ({ path, anchor }: { path: string; anchor: string | null }) => {
  const { session, select, status, historical } = useReview();
  const [editor, setEditor] = useState(false);
  const [tab, setTab] = useState<'diff' | 'fix'>('diff');
  const change = session.snapshot.changes.find(
    (entry) => entry.newPath === path || entry.oldPath === path,
  );
  const stat = diffStats(session.snapshot).get(path) ?? { added: 0, removed: 0 };
  const findings = sortFindings(session.findings.filter((entry) => entry.file === path));
  return (
    <div className="file-panel">
      <div className="fp-head">
        <span className={`file-status st-${change?.status ?? 'M'}`}>{change?.status ?? 'M'}</span>
        <div className="fp-name">
          <h2>{fileName(path)}</h2>
          <small>{dirName(path) || './'}</small>
        </div>
        <span className="churn">
          <span className="add">+{stat.added}</span>
          <span className="del">−{stat.removed}</span>
        </span>
      </div>
      {change?.oldPath && change.newPath && change.oldPath !== change.newPath && (
        <p className="muted small">
          Renamed from <code>{change.oldPath}</code>
        </p>
      )}
      {findings.length > 0 && (
        <div className="fp-findings">
          {findings.map((finding) => (
            <button
              key={finding.id}
              type="button"
              className="mini-finding"
              onClick={() => select({ kind: 'finding', id: finding.id })}
            >
              <Pill tint={severityMeta[finding.severity].tint} dot>
                L{finding.line}
              </Pill>
              <span>{finding.title}</span>
              <small>{statusMeta[status(finding)].label}</small>
            </button>
          ))}
        </div>
      )}
      <div className="panel-tabs">
        <div className="fd-tabs" role="tablist" aria-label="File sections">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'diff'}
            className={tab === 'diff' ? 'is-on' : ''}
            onClick={() => setTab('diff')}
          >
            Diff
          </button>
          {!historical && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'fix'}
              className={tab === 'fix' ? 'is-on' : ''}
              onClick={() => setTab('fix')}
            >
              Patches
            </button>
          )}
        </div>
        <Button size="sm" variant="soft" icon="fit" onClick={() => setEditor(true)}>
          Open side-by-side editor
        </Button>
      </div>
      <div className="tab-body" role="tabpanel">
        {tab === 'diff' && (
          <DiffView
            snapshot={session.snapshot}
            path={path}
            findings={session.findings}
            focus={anchor}
            onFinding={(finding) => select({ kind: 'finding', id: finding.id })}
            label={`Diff for ${path}`}
          />
        )}
        {tab === 'fix' && <PatchFlow file={path} />}
      </div>
      {editor && (
        <Suspense
          fallback={
            <div className="code-focus is-loading">
              <span className="loader" />
            </div>
          }
        >
          <CodeEditor
            snapshot={session.snapshot}
            path={path}
            findings={session.findings}
            onClose={() => setEditor(false)}
            onFinding={(finding) => {
              setEditor(false);
              select({ kind: 'finding', id: finding.id });
            }}
          />
        </Suspense>
      )}
    </div>
  );
};

const AgentPanel = ({ id }: { id: keyof typeof agentMeta }) => {
  const { session, select } = useReview();
  const meta = agentMeta[id];
  const route = session.plan?.agents.find((entry) => entry.id === id);
  const result = session.orchestration?.agents.find((entry) => entry.id === id);
  const kept = new Set(session.findings.map(findingKey));
  return (
    <div className="agent-panel">
      <div className="ap-head">
        <Avatar tint={meta.tint} glyph={meta.glyph} size={44} />
        <div>
          <h2>{meta.name} reviewer</h2>
          <p className="muted">{meta.role}</p>
        </div>
      </div>
      <dl className="kv">
        <dt>Status</dt>
        <dd>{result?.status ?? 'queued'}</dd>
        <dt>Model</dt>
        <dd>
          {route ? `${providerMeta[route.target.provider].name} · ${route.target.model}` : '—'}
        </dd>
        <dt>Destination</dt>
        <dd>
          <Icon
            name={route && providerMeta[route.target.provider].hosted ? 'cloud' : 'lock'}
            size={12}
          />{' '}
          {route?.target.endpoint ?? '—'}
        </dd>
        <dt>Attempts</dt>
        <dd>{result?.attempts ?? 0}</dd>
        <dt>Receives</dt>
        <dd>
          Selected diffs, rules and frozen related code
          {id === 'verifier' ? ', plus candidate findings' : ''}
        </dd>
      </dl>
      {result?.error && <p className="note is-error">{result.error}</p>}
      <h3 className="panel-h3">Candidates · {result?.findings.length ?? 0}</h3>
      <p className="muted small">
        What this reviewer proposed before deduplication and verification.
      </p>
      <div className="candidates">
        {result?.findings.map((finding, index) => {
          const survived = kept.has(findingKey(finding));
          const match = session.findings.find((entry) => findingKey(entry) === findingKey(finding));
          return (
            <button
              key={index}
              type="button"
              className={`candidate ${survived ? '' : 'is-dropped'}`}
              disabled={!match}
              onClick={() => match && select({ kind: 'finding', id: match.id })}
            >
              <Pill tint={severityMeta[finding.severity].tint} dot>
                {severityMeta[finding.severity].label}
              </Pill>
              <span>
                <strong>{finding.title}</strong>
                <small>
                  {finding.file}:{finding.line} · {survived ? 'on the board' : 'not confirmed'}
                </small>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

const ChatPanel = () => {
  const { session, interaction, refresh } = useReview();
  const { act, busy } = useWorkspace();
  const rules = interaction?.rules ?? [];
  const comparisons =
    interaction?.comparisons.filter((entry) => entry.runId === runIdOf(session)) ?? [];
  return (
    <div className="chat-panel">
      <details className="disclosure chat-extras">
        <summary>
          <Icon name="book" size={13} /> Learned rules · {rules.length}
          {comparisons.length > 0 && <> · compared with previous run</>}
        </summary>
        <section className="rules">
          <p className="muted small">
            Dismiss two findings as “preference” and ReviewLab can suggest a session rule so the
            crew stops flagging it. Repository rules are never changed.
          </p>
          <Button
            size="sm"
            variant="soft"
            icon="sparkle"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api(`/sessions/${session.id}/rule-suggestions`, {
                  method: 'POST',
                  body: JSON.stringify({ revision: interaction?.revision ?? 0 }),
                });
                await refresh();
              })
            }
          >
            Suggest a rule from my dismissals
          </Button>
          {rules.map((rule) => (
            <div key={rule.id} className="rule-card">
              <p>{rule.text}</p>
              <div className="rule-foot">
                <Pill
                  tint={
                    rule.status === 'accepted'
                      ? 'green'
                      : rule.status === 'rejected'
                        ? 'gray'
                        : 'purple'
                  }
                >
                  {rule.status}
                </Pill>
                {rule.status === 'suggested' &&
                  (['accepted', 'rejected'] as const).map((decision) => (
                    <Button
                      key={decision}
                      size="sm"
                      variant={decision === 'accepted' ? 'primary' : 'ghost'}
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api(`/sessions/${session.id}/rule-suggestions/${rule.id}`, {
                            method: 'POST',
                            body: JSON.stringify({
                              revision: interaction?.revision ?? 0,
                              decision,
                              consent: true,
                            }),
                          });
                          await refresh();
                        })
                      }
                    >
                      {decision === 'accepted' ? 'Use for future reruns' : 'Reject'}
                    </Button>
                  ))}
              </div>
            </div>
          ))}
          {comparisons.map((entry) => (
            <p key={entry.oldFindingId} className="small">
              <Pill
                tint={
                  entry.outcome === 'reintroduced'
                    ? 'red'
                    : entry.outcome === 'stale'
                      ? 'gray'
                      : 'blue'
                }
              >
                {entry.outcome}
              </Pill>{' '}
              {entry.note}
            </p>
          ))}
        </section>
      </details>
      <Thread />
    </div>
  );
};

const eventLabel: Record<string, string> = {
  'session.created': 'Review created',
  'snapshot.captured': 'Snapshot frozen',
  'context.resolved': 'Related code gathered',
  'run.queued': 'Queued',
  'run.started': 'Crew started',
  'agent.started': 'Reviewer started',
  'agent.progress': 'Reviewer update',
  'finding.validated': 'Finding validated',
  'finding.dismissed': 'Finding dismissed',
  'run.completed': 'Review complete',
  'run.failed': 'Review failed',
  'run.cancelled': 'Review cancelled',
};

const ActivityPanel = () => {
  const { events, session } = useReview();
  const runId = session.runId;
  const visible = events.filter((event) => !runId || !event.runId || event.runId === runId);
  return (
    <div className="timeline activity">
      {visible.length === 0 && <p className="muted small">No saved events for this run yet.</p>}
      {visible.map((event) => (
        <div key={event.id} className="tl-item">
          <span
            className={`tl-dot ${event.type.includes('failed') ? 'tint-red' : event.type.includes('completed') ? 'tint-green' : ''}`}
          />
          <div>
            <strong>{eventLabel[event.type] ?? event.type}</strong>
            {typeof event.data.agent === 'string' && (
              <span>
                {' '}
                · {agentMeta[event.data.agent as keyof typeof agentMeta]?.name ?? event.data.agent}
              </span>
            )}
            {typeof event.data.message === 'string' && <p>{event.data.message}</p>}
            <small>
              <time dateTime={event.createdAt}>
                {new Date(event.createdAt).toLocaleTimeString()}
              </time>
            </small>
          </div>
        </div>
      ))}
    </div>
  );
};
