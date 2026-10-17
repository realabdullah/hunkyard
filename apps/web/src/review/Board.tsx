import type { Finding } from '@reviewlab/domain';
import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from 'react';
import { diffStats } from '../diff-lines';
import { useStoredState } from '../lib/hooks';
import {
  agentMeta,
  dirName,
  dismissReasons,
  fileName,
  isLive,
  providerMeta,
  scopeMeta,
  severityMeta,
  shortSha,
  statusMeta,
} from '../lib/meta';
import { useWorkspace } from '../lib/workspace';
import { Icon } from '../ui/Icon';
import { Avatar, Menu, MenuItem, Pill } from '../ui/primitives';
import { Canvas, type CanvasHandle } from './Canvas';
import { Celebrate, useJustCleared } from './Celebrate';
import { decide, useReview } from './context';
import { boundsOf, type CardBox, layoutBoard } from './layout';

type Offsets = Record<string, { dx: number; dy: number }>;

export const Board = () => {
  const review = useReview();
  const { session, selection, select, status, interaction } = review;
  const canvas = useRef<CanvasHandle>(null);
  const [offsets, setOffsets] = useStoredState<Offsets>(`reviewlab.board.${session.id}`, {});
  const [hover, setHover] = useState<string | null>(null);
  const layout = useMemo(() => layoutBoard(session), [session]);
  const cards = useMemo(
    () =>
      layout.cards.map((card) => {
        const offset = offsets[card.id];
        return offset ? { ...card, x: card.x + offset.dx, y: card.y + offset.dy } : card;
      }),
    [layout, offsets],
  );
  const byId = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const initial = useMemo(() => boundsOf(layout.cards, 40), [layout]);
  const findingById = useMemo(
    () => new Map(session.findings.map((finding) => [finding.id, finding])),
    [session.findings],
  );
  const stats = useMemo(() => diffStats(session.snapshot), [session.snapshot]);
  const selectedId =
    selection?.kind === 'finding'
      ? `finding:${selection.id}`
      : selection?.kind === 'file'
        ? `file:${selection.path}`
        : selection?.kind === 'agent'
          ? `agent:${selection.id}`
          : selection?.kind === 'evidence'
            ? 'snapshot'
            : (selection?.kind ?? null);
  const focusFinding = findingById.get((hover ?? selectedId ?? '').replace('finding:', ''));
  const live = isLive(session.status);
  const settled = session.findings.filter((finding) => statusMeta[status(finding)].settled).length;
  const cleared = useJustCleared(interaction ? settled : null, session.findings.length);

  const drag = (card: CardBox, event: ReactPointerEvent) => {
    if ((event.target as HTMLElement).closest('.card-actions, .menu')) return;
    if (event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY };
    const base = offsets[card.id] ?? { dx: 0, dy: 0 };
    const k = canvas.current?.view().k ?? 1;
    let moved = false;
    const move = (next: PointerEvent) => {
      const dx = (next.clientX - start.x) / k;
      const dy = (next.clientY - start.y) / k;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      setOffsets((all) => ({ ...all, [card.id]: { dx: base.dx + dx, dy: base.dy + dy } }));
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      if (moved) {
        const swallow = (click: MouseEvent) => {
          click.stopPropagation();
          click.preventDefault();
        };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  const sectionBoxes = layout.sections
    .map((section) => {
      const members = section.cards
        .map((id) => byId.get(id))
        .filter((card): card is CardBox => Boolean(card));
      return members.length ? { section, box: boundsOf(members, 22) } : null;
    })
    .filter((entry) => entry !== null);

  const edge = (from: CardBox, to: CardBox) => {
    const x1 = from.x + from.w;
    const y1 = from.y + Math.min(from.h / 2, 40);
    const x2 = to.x;
    const y2 = to.y + Math.min(to.h / 2, 40);
    const bend = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
  };
  const snapshotCard = byId.get('snapshot');
  return (
    <div className="board">
      <Canvas
        ref={canvas}
        initial={initial}
        onBackground={() => select(null)}
        overlay={
          <>
            <div className="board-legend" aria-hidden="true">
              <span>
                <i className="lg lg-crew" /> reads
              </span>
              <span>
                <i className="lg lg-finding" /> found in
              </span>
              <span className="muted">Drag cards · Space+drag to pan · ⌘ scroll to zoom</span>
            </div>
            {cleared && <Celebrate total={session.findings.length} />}
          </>
        }
      >
        {sectionBoxes.map(({ section, box }) => (
          <div
            key={section.id}
            className={`section tint-${section.tint}`}
            style={{ left: box.x, top: box.y - 30, width: box.w, height: box.h + 30 }}
          >
            <span className="section-title">{section.title}</span>
          </div>
        ))}
        <svg className="edges" aria-hidden="true">
          {snapshotCard &&
            cards
              .filter((card) => card.kind === 'agent')
              .map((card) => (
                <path
                  key={`e:${card.id}`}
                  d={edge(snapshotCard, card)}
                  className={`edge edge-crew ${live ? 'is-live' : ''}`}
                />
              ))}
          {cards
            .filter((card) => card.kind === 'finding' && card.ref)
            .map((card) => {
              const finding = findingById.get(card.ref ?? '');
              const file = finding && byId.get(`file:${finding.file}`);
              if (!finding || !file) return null;
              const done = statusMeta[status(finding)].settled;
              return (
                <path
                  key={`e:${card.id}`}
                  d={edge(file, card)}
                  className={`edge edge-finding ink-${severityMeta[finding.severity].tint} ${done ? 'is-done' : ''} ${focusFinding?.id === finding.id ? 'is-hot' : ''}`}
                />
              );
            })}
          {focusFinding?.attributions?.map((attribution) => {
            const agent = byId.get(`agent:${attribution.agent}`);
            const card = byId.get(`finding:${focusFinding.id}`);
            if (!agent || !card) return null;
            return (
              <path
                key={`a:${attribution.agent}`}
                d={edge(agent, card)}
                className="edge edge-attrib"
              />
            );
          })}
        </svg>
        {cards.map((card) => (
          <div
            key={card.id}
            data-card
            className={`card card-${card.kind} ${selectedId === card.id ? 'is-selected' : ''}`}
            style={{ left: card.x, top: card.y, width: card.w, minHeight: card.h }}
            onPointerDown={(event) => drag(card, event)}
            onPointerEnter={() => card.kind === 'finding' && setHover(card.id)}
            onPointerLeave={() => card.kind === 'finding' && setHover(null)}
          >
            <CardBody
              card={card}
              finding={card.ref ? findingById.get(card.ref) : undefined}
              stats={stats}
            />
          </div>
        ))}
      </Canvas>
    </div>
  );
};

const CardBody = ({
  card,
  finding,
  stats,
}: {
  card: CardBox;
  finding: Finding | undefined;
  stats: Map<string, { added: number; removed: number }>;
}) => {
  const { session, select, interaction, status, events, refresh, historical } = useReview();
  const { act, busy } = useWorkspace();
  const snapshot = session.snapshot;
  switch (card.kind) {
    case 'snapshot':
      return (
        <button type="button" className="card-hit" onClick={() => select({ kind: 'evidence' })}>
          <span className="card-kicker">
            <Icon name="snowflake" size={13} /> Frozen snapshot
          </span>
          <strong className="card-title">{scopeMeta[snapshot.scope].title}</strong>
          <dl className="mini-dl">
            <dt>HEAD</dt>
            <dd>{shortSha(snapshot.headSha)}</dd>
            <dt>Diff</dt>
            <dd>{snapshot.diffHash.slice(0, 10)}</dd>
            <dt>Context</dt>
            <dd>
              {session.context?.files.length ?? 0}/{snapshot.files.length} files
              {snapshot.omissions?.length ? ` · ${snapshot.omissions.length} omitted` : ''}
            </dd>
            <dt>Rules</dt>
            <dd>{session.policy.sources.length} sources</dd>
          </dl>
          <span className="card-foot">Evidence & provenance →</span>
        </button>
      );
    case 'pr': {
      const pr = snapshot.pullRequest;
      if (!pr) return null;
      return (
        <button type="button" className="card-hit" onClick={() => select({ kind: 'pr' })}>
          <span className="card-kicker">
            <Icon name="github" size={13} /> {pr.repository} #{pr.number}
          </span>
          <strong className="card-title clamp-2">{pr.title}</strong>
          <span className="card-meta">
            <Pill tint={pr.state === 'open' ? 'green' : 'gray'}>{pr.state}</Pill>
            {pr.comments.length} comments · {pr.checks.length} checks
          </span>
        </button>
      );
    }
    case 'chat': {
      const messages = interaction?.messages.filter((message) => !message.findingId) ?? [];
      const last = messages.at(-1);
      return (
        <button type="button" className="card-hit" onClick={() => select({ kind: 'chat' })}>
          <span className="card-kicker">
            <Icon name="chat" size={13} /> Discussion · {messages.length}
          </span>
          <span className="card-text clamp-2">
            {last
              ? last.text
              : 'Ask the model about this review, or leave notes and decisions for later.'}
          </span>
        </button>
      );
    }
    case 'agent': {
      const id = card.ref as keyof typeof agentMeta;
      const meta = agentMeta[id];
      const route = session.plan?.agents.find((entry) => entry.id === id);
      const result = session.orchestration?.agents.find((entry) => entry.id === id);
      const state =
        result?.status ??
        (isLive(session.status)
          ? 'queued'
          : session.status === 'completed'
            ? 'completed'
            : 'queued');
      const lastProgress = [...events]
        .reverse()
        .find((event) => event.data.agent === id && typeof event.data.message === 'string');
      return (
        <button
          type="button"
          className={`card-hit agent is-${state}`}
          onClick={() => select({ kind: 'agent', id })}
        >
          <span className="agent-row">
            <span className="agent-avatar">
              <Avatar tint={meta.tint} glyph={meta.glyph} size={32} />
            </span>
            <span className="agent-text">
              <strong>{meta.name}</strong>
              <small>
                {state === 'running' && lastProgress
                  ? String(lastProgress.data.message)
                  : meta.role}
              </small>
            </span>
            <AgentState state={state} count={result?.findings.length ?? 0} />
          </span>
          {route && (
            <span className="agent-model">
              <Icon
                name={providerMeta[route.target.provider].hosted ? 'cloud' : 'lock'}
                size={11}
              />
              {route.target.model}
            </span>
          )}
        </button>
      );
    }
    case 'file': {
      const path = card.ref ?? '';
      const change = snapshot.changes.find(
        (entry) => entry.newPath === path || entry.oldPath === path,
      );
      const stat = stats.get(path) ?? { added: 0, removed: 0 };
      const fileFindings = session.findings.filter((entry) => entry.file === path);
      const total = Math.max(1, stat.added + stat.removed);
      return (
        <button type="button" className="card-hit" onClick={() => select({ kind: 'file', path })}>
          <span className="file-row">
            <span className={`file-status st-${change?.status ?? 'M'}`}>
              {change?.status ?? 'M'}
            </span>
            <span className="file-text">
              <strong>{fileName(path)}</strong>
              <small>{dirName(path) || './'}</small>
            </span>
            {fileFindings.length > 0 && <span className="file-flags">{fileFindings.length}</span>}
          </span>
          <span className="churn">
            <span className="churn-bar">
              <i className="add" style={{ width: `${(stat.added / total) * 100}%` }} />
              <i className="del" style={{ width: `${(stat.removed / total) * 100}%` }} />
            </span>
            <span className="add">+{stat.added}</span>
            <span className="del">−{stat.removed}</span>
            {change?.binary && <span>binary</span>}
          </span>
        </button>
      );
    }
    case 'finding': {
      if (!finding) return null;
      const current = status(finding);
      const severity = severityMeta[finding.severity];
      const settled = statusMeta[current].settled;
      return (
        <div className={`finding-card ${settled ? 'is-settled' : ''} st-${current}`}>
          <i className={`finding-strip tint-${severity.tint}`} />
          <button
            type="button"
            className="card-hit"
            onClick={() => select({ kind: 'finding', id: finding.id })}
          >
            <span className="card-meta">
              <Pill tint={severity.tint} dot>
                {severity.label}
              </Pill>
              {current !== 'open' && (
                <Pill tint={statusMeta[current].tint}>{statusMeta[current].label}</Pill>
              )}
              {finding.verified && (
                <span className="verified" title="Independently verified">
                  <Icon name="shield" size={12} />
                </span>
              )}
            </span>
            <strong className="card-title clamp-2">{finding.title}</strong>
            <span className="card-loc">
              {fileName(finding.file)}:{finding.line}
              {finding.side === 'old' ? ' (removed)' : ''}
            </span>
          </button>
          {!historical && (
            <div className="card-actions">
              {current !== 'accepted' && !settled && (
                <button
                  type="button"
                  className="quick"
                  disabled={busy}
                  title="Will fix (A)"
                  aria-label={`Mark “${finding.title}” as will fix`}
                  onClick={() =>
                    void act(async () => {
                      await decide(session, finding, 'accepted');
                      await refresh();
                    })
                  }
                >
                  <Icon name="check" size={13} />
                </button>
              )}
              {settled ? (
                <button
                  type="button"
                  className="quick"
                  disabled={busy}
                  title="Reopen (U)"
                  aria-label={`Reopen “${finding.title}”`}
                  onClick={() =>
                    void act(async () => {
                      await decide(session, finding, 'open');
                      await refresh();
                    })
                  }
                >
                  <Icon name="refresh" size={13} />
                </button>
              ) : (
                <Menu
                  trigger={(props) => (
                    <button
                      type="button"
                      className="quick"
                      title="Dismiss (D)"
                      aria-label={`Dismiss “${finding.title}”`}
                      {...props}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  )}
                >
                  {(close) =>
                    dismissReasons.map((reason) => (
                      <MenuItem
                        key={reason.id}
                        hint={reason.hint}
                        onClick={() => {
                          close();
                          void act(async () => {
                            await decide(session, finding, 'dismissed', { reason: reason.id });
                            await refresh();
                          });
                        }}
                      >
                        {reason.label}
                      </MenuItem>
                    ))
                  }
                </Menu>
              )}
            </div>
          )}
        </div>
      );
    }
    case 'placeholder':
      return isLive(session.status) ? (
        <div className="placeholder is-live">
          <span className="card-kicker">
            <Icon name="sparkle" size={13} /> Reviewing…
          </span>
          <i className="shimmer" />
          <i className="shimmer short" />
          <small>Findings appear here once validated against the diff.</small>
        </div>
      ) : session.status === 'completed' ? (
        <div className="placeholder is-clean">
          <span className="clean-badge">
            <Icon name="check" size={18} />
          </span>
          <strong>All clear</strong>
          <small>No actionable findings in the reviewed files. Nice work.</small>
        </div>
      ) : (
        <div className="placeholder">
          <strong>No findings</strong>
          <small>
            This run {session.status === 'cancelled' ? 'was cancelled' : 'failed'} before reporting.
          </small>
        </div>
      );
  }
};

const AgentState = ({ state, count }: { state: string; count: number }) => {
  if (state === 'running') return <span className="agent-state is-running" aria-label="Running" />;
  if (state === 'failed') return <Pill tint="red">Failed</Pill>;
  if (state === 'cancelled') return <Pill tint="gray">Stopped</Pill>;
  if (state === 'completed')
    return (
      <span className="agent-count" title={`${count} candidate findings`}>
        {count}
      </span>
    );
  return <Pill tint="gray">Queued</Pill>;
};
