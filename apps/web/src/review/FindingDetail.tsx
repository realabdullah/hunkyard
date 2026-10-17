import type { Finding, FindingStatus } from '@reviewlab/domain';
import { useState } from 'react';
import {
  agentMeta,
  dismissReasons,
  providerMeta,
  runIdOf,
  severityMeta,
  statusMeta,
} from '../lib/meta';
import { useWorkspace } from '../lib/workspace';
import { Icon } from '../ui/Icon';
import { Avatar, Button, Kbd, Menu, MenuItem, Pill } from '../ui/primitives';
import { decide, useReview } from './context';
import { DiffView } from './DiffView';
import { PatchFlow } from './panels/PatchFlow';
import { Thread } from './panels/Thread';

const tabs = ['Overview', 'Discuss', 'Fix', 'History'] as const;
type Tab = (typeof tabs)[number];

export const FindingDetail = ({ finding, compact }: { finding: Finding; compact?: boolean }) => {
  const { session, interaction, status, select, historical } = useReview();
  const [tab, setTab] = useState<Tab>('Overview');
  const severity = severityMeta[finding.severity];
  const current = status(finding);
  const runId = runIdOf(session);
  const threadCount =
    interaction?.messages.filter(
      (message) => message.runId === runId && message.findingId === finding.id,
    ).length ?? 0;
  const anchor = `${finding.side}:${finding.file}:${finding.line}`;
  return (
    <article className={`finding-detail ${compact ? 'is-compact' : ''}`} aria-label={finding.title}>
      <header className="fd-head">
        <div className="fd-pills">
          <Pill tint={severity.tint} dot>
            {severity.label}
          </Pill>
          <Pill tint={statusMeta[current].tint}>{statusMeta[current].label}</Pill>
          {finding.verified && (
            <Pill tint="green">
              <Icon name="shield" size={11} /> Verified
            </Pill>
          )}
          {finding.confidence && <Pill tint="gray">{finding.confidence} confidence</Pill>}
        </div>
        <h2>{finding.title}</h2>
        <div className="fd-sub">
          <button
            type="button"
            className="loc-chip"
            onClick={() => select({ kind: 'file', path: finding.file, anchor })}
          >
            <Icon name="file" size={13} />
            {finding.file}:{finding.line}
            {finding.side === 'old' ? ' (removed line)' : ''}
          </button>
          <span className="fd-crew">
            {(finding.attributions ?? []).map((entry) => (
              <span
                key={entry.agent}
                title={`${agentMeta[entry.agent].name} · ${providerMeta[entry.target.provider].name}/${entry.target.model}`}
              >
                <Avatar
                  tint={agentMeta[entry.agent].tint}
                  glyph={agentMeta[entry.agent].glyph}
                  size={22}
                />
              </span>
            ))}
            {!finding.attributions && (
              <small>
                {providerMeta[finding.provider].name} · {finding.model}
              </small>
            )}
          </span>
        </div>
        {!historical && <DecisionBar finding={finding} current={current} />}
      </header>
      <div className="fd-tabs" role="tablist" aria-label="Finding sections">
        {tabs.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? 'is-on' : ''}
            onClick={() => setTab(name)}
          >
            {name}
            {name === 'Discuss' && threadCount > 0 && <span className="count">{threadCount}</span>}
          </button>
        ))}
      </div>
      <div className="fd-body">
        {tab === 'Overview' && (
          <>
            <section className="fd-section">
              <h3>What’s wrong</h3>
              <p className="prose">{finding.explanation}</p>
            </section>
            <section className="fd-section">
              <h3>In the diff</h3>
              <DiffView
                snapshot={session.snapshot}
                path={finding.file}
                findings={[finding]}
                focus={anchor}
                window={compact ? 4 : 6}
                label={`Diff around ${finding.file}:${finding.line}`}
              />
              <p className="muted small">
                Evidence quoted by the reviewer:{' '}
                <code className="inline-code">{finding.evidence}</code>
              </p>
            </section>
            <section className="fd-section fd-fix">
              <h3>
                <Icon name="sparkle" size={14} /> Suggested fix
              </h3>
              <p className="prose">{finding.recommendation}</p>
              {!historical && (
                <Button size="sm" variant="ghost" icon="wrench" onClick={() => setTab('Fix')}>
                  Turn this into a patch
                </Button>
              )}
            </section>
            {(finding.ruleRefs?.length ?? 0) > 0 && (
              <section className="fd-section">
                <h3>Rules referenced</h3>
                <div className="chip-row">
                  {finding.ruleRefs?.map((rule) => (
                    <Pill key={rule} tint="purple">
                      {rule}
                    </Pill>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
        {tab === 'Discuss' && <Thread findingId={finding.id} />}
        {tab === 'Fix' &&
          (historical ? (
            <p className="muted">Patches are proposed on the latest run.</p>
          ) : (
            <PatchFlow file={finding.file} findingId={finding.id} />
          ))}
        {tab === 'History' && <History finding={finding} />}
      </div>
    </article>
  );
};

const History = ({ finding }: { finding: Finding }) => {
  const { interaction, session } = useReview();
  const runId = runIdOf(session);
  const transitions =
    interaction?.transitions.filter((entry) => entry.findingId === finding.id) ?? [];
  const comparisons =
    interaction?.comparisons.filter(
      (entry) =>
        entry.runId === runId &&
        (entry.newFindingId === finding.id || entry.oldFindingId === finding.id),
    ) ?? [];
  return (
    <div className="timeline">
      <div className="tl-item">
        <span className="tl-dot" />
        <div>
          <strong>Found</strong> by{' '}
          {finding.attributions?.map((entry) => agentMeta[entry.agent].name).join(', ') ??
            finding.model}
          <small>
            Snapshot {finding.snapshotId.slice(0, 8)} · policy {finding.policyHash.slice(0, 8)} ·{' '}
            {finding.promptVersion}
          </small>
        </div>
      </div>
      {comparisons.map((entry) => (
        <div key={`${entry.oldFindingId}${entry.outcome}`} className="tl-item">
          <span className="tl-dot is-purple" />
          <div>
            <strong>Matched across runs: {entry.outcome}</strong>
            <small>{entry.note}</small>
          </div>
        </div>
      ))}
      {transitions.map((entry) => (
        <div key={entry.id} className="tl-item">
          <span className={`tl-dot tint-${statusMeta[entry.to].tint}`} />
          <div>
            <strong>
              {statusMeta[entry.from].label} → {statusMeta[entry.to].label}
            </strong>
            {entry.reason && <span> · {entry.reason}</span>}
            {entry.note && <p>{entry.note}</p>}
            <small>
              {entry.actor} · {new Date(entry.createdAt).toLocaleString()}
            </small>
          </div>
        </div>
      ))}
      {!transitions.length && <p className="muted small">No decisions yet.</p>}
    </div>
  );
};

export const DecisionBar = ({ finding, current }: { finding: Finding; current: FindingStatus }) => {
  const { session, refresh } = useReview();
  const { act, busy } = useWorkspace();
  const [note, setNote] = useState('');
  const [noting, setNoting] = useState(false);
  const set = (status: FindingStatus, reason?: string) =>
    void act(async () => {
      await decide(session, finding, status, { ...(reason ? { reason } : {}), note });
      setNote('');
      setNoting(false);
      await refresh();
    });
  const options: {
    status: FindingStatus;
    label: string;
    icon: 'check' | 'eye' | 'wrench';
    key: string;
  }[] = [
    { status: 'accepted', label: 'Will fix', icon: 'check', key: 'A' },
    { status: 'investigating', label: 'Investigate', icon: 'eye', key: 'I' },
    { status: 'fixed', label: 'Fixed', icon: 'wrench', key: 'F' },
  ];
  return (
    <div className="decision">
      <div className="decision-row" role="group" aria-label="Decide on this finding">
        {options.map((option) => (
          <button
            key={option.status}
            type="button"
            disabled={busy}
            aria-pressed={current === option.status}
            className={`decide decide-${option.status} ${current === option.status ? 'is-on' : ''}`}
            onClick={() => set(current === option.status ? 'open' : option.status)}
          >
            <Icon name={option.icon} size={14} />
            {option.label}
            <Kbd>{option.key}</Kbd>
          </button>
        ))}
        <Menu
          trigger={(props) => (
            <button
              type="button"
              disabled={busy}
              className={`decide decide-dismissed ${current === 'dismissed' ? 'is-on' : ''}`}
              {...props}
            >
              <Icon name="close" size={14} />
              Dismiss
              <Kbd>D</Kbd>
            </button>
          )}
        >
          {(close) =>
            dismissReasons.map((reason, index) => (
              <MenuItem
                key={reason.id}
                hint={reason.hint}
                onClick={() => {
                  close();
                  set('dismissed', reason.id);
                }}
              >
                <Kbd>{index + 1}</Kbd> {reason.label}
              </MenuItem>
            ))
          }
        </Menu>
        {current !== 'open' && (
          <button type="button" className="link" disabled={busy} onClick={() => set('open')}>
            Reopen
          </button>
        )}
      </div>
      {noting ? (
        <textarea
          className="decision-note"
          rows={2}
          maxLength={4000}
          value={note}
          autoFocus
          placeholder="Why? This note is saved with your next decision."
          aria-label="Decision note"
          onChange={(event) => setNote(event.target.value)}
        />
      ) : (
        <button type="button" className="link small" onClick={() => setNoting(true)}>
          + Add a note to the decision
        </button>
      )}
    </div>
  );
};
