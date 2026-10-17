import type { Finding } from '@reviewlab/domain';
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import {
  boundsOf,
  type CardBox,
  layoutBoard,
  mapInset,
  type Stats,
  tileRect,
  worstSeverity,
} from './layout';
import type { Tile } from './treemap';

type Offsets = Record<string, { dx: number; dy: number }>;

export const Board = () => {
  const review = useReview();
  const { session, selection, select, status, interaction } = review;
  const canvas = useRef<CanvasHandle>(null);
  const [offsets, setOffsets] = useStoredState<Offsets>(`reviewlab.board.${session.id}`, {});
  const [hover, setHover] = useState<string | null>(null);
  const stats = useMemo(() => diffStats(session.snapshot), [session.snapshot]);
  const layout = useMemo(() => layoutBoard(session, stats), [session, stats]);
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
  const selectedId =
    selection?.kind === 'finding'
      ? `finding:${selection.id}`
      : selection?.kind === 'file'
        ? 'files'
        : selection?.kind === 'agent'
          ? `agent:${selection.id}`
          : selection?.kind === 'evidence'
            ? 'snapshot'
            : (selection?.kind ?? null);
  const focusFinding = findingById.get((hover ?? selectedId ?? '').replace('finding:', ''));
  const hotFile = hover?.startsWith('file:')
    ? hover.slice(5)
    : selection?.kind === 'file'
      ? selection.path
      : (focusFinding?.file ?? null);
  const live = isLive(session.status);
  const settled = session.findings.filter((finding) => statusMeta[status(finding)].settled).length;
  const cleared = useJustCleared(interaction ? settled : null, session.findings.length);

  const drag = (card: CardBox, event: ReactPointerEvent) => {
    if ((event.target as HTMLElement).closest('.card-actions, .menu, .tile')) return;
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
      return members.length ? { section, box: boundsOf(members, 18) } : null;
    })
    .filter((entry) => entry !== null);

  const selectedBox = selectedId ? byId.get(selectedId) : undefined;
  const selectedKey = selectedBox
    ? `${selectedBox.id}:${Math.round(selectedBox.x)}:${Math.round(selectedBox.y)}`
    : null;
  useEffect(() => {
    if (!selectedBox) return;
    const wide = document.querySelector('.side-panel.is-wide');
    const timer = setTimeout(() => canvas.current?.reveal(selectedBox, wide ? 800 : 490), 30);
    return () => clearTimeout(timer);
  }, [selectedKey]);

  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const bend = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
  };
  const edge = (from: CardBox, to: CardBox) =>
    curve(from.x + from.w, from.y + Math.min(from.h / 2, 40), to.x, to.y + Math.min(to.h / 2, 40));
  const snapshotCard = byId.get('snapshot');
  const map = byId.get('files');
  const tileByPath = new Map(layout.tiles.map((tile) => [tile.item, tile]));
  const portY = (path: string) => {
    const tile = tileByPath.get(path);
    if (!map || !tile) return null;
    const rect = tileRect(map, tile);
    return Math.min(map.y + map.h - 14, Math.max(map.y + mapInset.top + 6, rect.y + rect.h / 2));
  };
  const ports = new Map<string, number>();
  for (const finding of session.findings) {
    const y = portY(finding.file);
    if (y !== null) ports.set(finding.file, y);
  }
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
            className={`section section-${section.id}`}
            style={{ left: box.x, top: box.y - 30, width: box.w, height: box.h + 30 }}
          >
            <span className="section-title">
              {section.title}
              {section.count !== undefined && <b>{section.count}</b>}
            </span>
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
          {map &&
            cards
              .filter((card) => card.kind === 'agent')
              .map((card) => (
                <path
                  key={`m:${card.id}`}
                  d={edge(card, map)}
                  className={`edge edge-read ${live ? 'is-live' : ''}`}
                />
              ))}
          {map &&
            cards
              .filter((card) => card.kind === 'finding' && card.ref)
              .map((card) => {
                const finding = findingById.get(card.ref ?? '');
                const y = finding ? ports.get(finding.file) : undefined;
                if (!finding || y === undefined) return null;
                const done = statusMeta[status(finding)].settled;
                const hot = focusFinding?.id === finding.id || hotFile === finding.file;
                return (
                  <path
                    key={`e:${card.id}`}
                    d={curve(map.x + map.w, y, card.x, card.y + Math.min(card.h / 2, 40))}
                    className={`edge edge-finding ink-${severityMeta[finding.severity].tint} ${done ? 'is-done' : ''} ${hot ? 'is-hot' : ''}`}
                  />
                );
              })}
          {map &&
            [...ports].map(([path, y]) => (
              <circle
                key={`p:${path}`}
                cx={map.x + map.w}
                cy={y}
                r={hotFile === path ? 5 : 3.5}
                className={`port ${hotFile === path ? 'is-hot' : ''}`}
              />
            ))}
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
        {cards.map((card, index) => (
          <div
            key={card.id}
            data-card
            className={`card card-${card.kind} ${selectedId === card.id ? 'is-selected' : ''} ${card.ref && card.ref === focusFinding?.id ? 'is-hot' : ''}`}
            style={{
              left: card.x,
              top: card.y,
              width: card.w,
              minHeight: card.h,
              ...(card.kind === 'files' ? { height: card.h } : {}),
              animationDelay: `${Math.min(index, 14) * 35}ms`,
            }}
            onPointerDown={(event) => drag(card, event)}
            onPointerEnter={() => card.kind === 'finding' && setHover(card.id)}
            onPointerLeave={() => card.kind === 'finding' && setHover(null)}
          >
            {card.kind === 'files' ? (
              <ChangeMap tiles={layout.tiles} stats={stats} hotFile={hotFile} setHover={setHover} />
            ) : (
              <CardBody card={card} finding={card.ref ? findingById.get(card.ref) : undefined} />
            )}
          </div>
        ))}
      </Canvas>
    </div>
  );
};

/** Half the gap between neighbouring tiles; tiles never touch each other or the map edge. */
const gutter = 2;

/** Every changed file as one tile, sized by churn and tinted by its worst open finding. */
const ChangeMap = ({
  tiles,
  stats,
  hotFile,
  setHover,
}: {
  tiles: Tile<string>[];
  stats: Stats;
  hotFile: string | null;
  setHover: (id: string | null) => void;
}) => {
  const { session, select, status, selection } = useReview();
  const totals = [...stats.values()].reduce(
    (sum, stat) => ({ added: sum.added + stat.added, removed: sum.removed + stat.removed }),
    { added: 0, removed: 0 },
  );
  return (
    <div className="change-map">
      <header className="map-head">
        <span className="card-kicker">
          <Icon name="layers" size={13} /> {session.snapshot.files.length} files
        </span>
        <span className="map-churn">
          <span className="add">+{totals.added}</span>
          <span className="del">−{totals.removed}</span>
        </span>
      </header>
      <div
        className="map-field"
        style={{
          top: mapInset.top,
          left: mapInset.side,
          right: mapInset.side,
          bottom: mapInset.bottom,
        }}
      >
        {tiles.map((tile) => {
          const path = tile.item;
          const change = session.snapshot.changes.find(
            (entry) => entry.newPath === path || entry.oldPath === path,
          );
          const stat = stats.get(path) ?? { added: 0, removed: 0 };
          const fileFindings = session.findings.filter((entry) => entry.file === path);
          const open = fileFindings.filter((entry) => !statusMeta[status(entry)].settled);
          const worst = worstSeverity(open);
          const total = Math.max(1, stat.added + stat.removed);
          const roomy = tile.w > 70 && tile.h > 34;
          const selected = selection?.kind === 'file' && selection.path === path;
          return (
            <button
              key={path}
              type="button"
              className={`tile ${worst ? `tint-${severityMeta[worst].tint} has-findings` : ''} ${fileFindings.length && !open.length ? 'is-cleared' : ''} ${hotFile === path ? 'is-hot' : ''} ${selected ? 'is-selected' : ''}`}
              style={{
                left: tile.x + gutter,
                top: tile.y + gutter,
                width: tile.w - gutter * 2,
                height: tile.h - gutter * 2,
              }}
              title={`${path} · +${stat.added} −${stat.removed}${fileFindings.length ? ` · ${fileFindings.length} finding${fileFindings.length === 1 ? '' : 's'}` : ''}`}
              aria-label={`${path}, ${stat.added} added, ${stat.removed} removed, ${fileFindings.length} findings`}
              onClick={() => select({ kind: 'file', path })}
              onPointerEnter={() => setHover(`file:${path}`)}
              onPointerLeave={() => setHover(null)}
            >
              {roomy && (
                <span className="tile-text">
                  <strong>{fileName(path)}</strong>
                  {tile.h > 54 && <small>{dirName(path) || './'}</small>}
                </span>
              )}
              {fileFindings.length > 0 && <span className="tile-count">{fileFindings.length}</span>}
              {change && change.status !== 'M' && tile.w > 40 && (
                <span className={`tile-status st-${change.status}`}>{change.status}</span>
              )}
              <span className="tile-churn" aria-hidden="true">
                <i className="add" style={{ width: `${(stat.added / total) * 100}%` }} />
                <i className="del" style={{ width: `${(stat.removed / total) * 100}%` }} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

const CardBody = ({ card, finding }: { card: CardBox; finding: Finding | undefined }) => {
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
    case 'files':
      return null;
    case 'finding': {
      if (!finding) return null;
      const current = status(finding);
      const severity = severityMeta[finding.severity];
      const settled = statusMeta[current].settled;
      return (
        <div
          className={`finding-card tint-${severity.tint} ${settled ? 'is-settled' : ''} st-${current}`}
        >
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
