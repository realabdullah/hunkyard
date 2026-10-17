import type { Finding, FindingStatus } from '@hunkyard/domain';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useHotkeys } from '../lib/hooks';
import {
  dismissReasons,
  fileName,
  isLive,
  severityMeta,
  sortFindings,
  statusMeta,
} from '../lib/meta';
import { useWorkspace } from '../lib/workspace';
import { Icon } from '../ui/Icon';
import { Empty, Kbd, Pill, useToast } from '../ui/primitives';
import { Celebrate, useJustCleared } from './Celebrate';
import { decide, useReview } from './context';
import { FindingDetail } from './FindingDetail';

type Filter = 'todo' | 'all' | 'done';
const severities = ['critical', 'high', 'medium', 'low', 'info'] as const;
const bucket = (severity: Finding['severity']) =>
  severity === 'major' ? 'high' : severity === 'minor' ? 'low' : severity;

export const Triage = () => {
  const { session, status, historical, refresh, interaction } = useReview();
  const { act } = useWorkspace();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('todo');
  const [levels, setLevels] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const list = useMemo(
    () =>
      sortFindings(session.findings)
        .filter((finding) => {
          const settled = statusMeta[status(finding)].settled;
          return filter === 'all' || (filter === 'todo' ? !settled : settled);
        })
        .filter((finding) => !levels.length || levels.includes(bucket(finding.severity)))
        .filter((finding) =>
          `${finding.title} ${finding.file} ${finding.explanation}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        ),
    [session.findings, status, filter, levels, query],
  );
  const opened = useRef(false);
  useEffect(() => {
    // Opening a fully decided review: show everything rather than an empty to-do list.
    if (opened.current || !interaction) return;
    opened.current = true;
    const open = session.findings.filter((finding) => !statusMeta[status(finding)].settled);
    if (session.findings.length && !open.length) setFilter('all');
  }, [interaction, session.findings, status]);
  const index = Math.max(
    0,
    list.findIndex((finding) => finding.id === cursorId),
  );
  const current = list[index];
  useEffect(() => {
    if (!list.some((finding) => finding.id === cursorId)) setCursorId(list[0]?.id ?? null);
  }, [list, cursorId]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('.is-cursor')?.scrollIntoView({ block: 'nearest' });
  }, [cursorId]);

  const move = (delta: number) => {
    const next = list[Math.min(list.length - 1, Math.max(0, index + delta))];
    if (next) setCursorId(next.id);
  };
  const set = (finding: Finding | undefined, next: FindingStatus, reason?: string) => {
    if (!finding || historical) return;
    // In the to-do view the decided card leaves the list, so keep the cursor where it is visually.
    const follow = filter === 'todo' ? (list[index + 1] ?? list[index - 1]) : finding;
    void act(async () => {
      await decide(session, finding, next, reason ? { reason } : {});
      await refresh();
      if (follow) setCursorId(follow.id);
      toast(`${statusMeta[next].label}: ${finding.title}`, 'success');
    });
  };
  useHotkeys(
    dismissing
      ? {
          ...Object.fromEntries(
            dismissReasons.map((reason, position) => [
              String(position + 1),
              () => {
                setDismissing(false);
                set(current, 'dismissed', reason.id);
              },
            ]),
          ),
          escape: () => setDismissing(false),
        }
      : {
          j: () => move(1),
          arrowdown: () => move(1),
          k: () => move(-1),
          arrowup: () => move(-1),
          a: () => set(current, 'accepted'),
          f: () => set(current, 'fixed'),
          i: () => set(current, 'investigating'),
          u: () => set(current, 'open'),
          d: () => current && !historical && setDismissing(true),
          '/': () => document.getElementById('triage-search')?.focus(),
        },
  );
  const total = session.findings.length;
  const done = session.findings.filter((finding) => statusMeta[status(finding)].settled).length;
  const cleared = useJustCleared(interaction ? done : null, total);
  return (
    <div className="triage">
      <div className="triage-list">
        <div className="triage-top">
          <div className="triage-progress" aria-label={`${done} of ${total} decided`}>
            <span style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
          </div>
          <div className="triage-filters">
            {(['todo', 'all', 'done'] as const).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={filter === id}
                className={`chip ${filter === id ? 'is-on' : ''}`}
                onClick={() => setFilter(id)}
              >
                {id === 'todo'
                  ? `To decide · ${total - done}`
                  : id === 'all'
                    ? `All · ${total}`
                    : `Decided · ${done}`}
              </button>
            ))}
          </div>
          <div className="sev-filter" role="group" aria-label="Severity filter">
            {severities.map((level) => {
              const count = session.findings.filter(
                (finding) => bucket(finding.severity) === level,
              ).length;
              if (!count) return null;
              const on = levels.includes(level);
              return (
                <button
                  key={level}
                  type="button"
                  aria-pressed={on}
                  className={`sev-chip tint-${severityMeta[level].tint} ${on ? 'is-on' : ''}`}
                  onClick={() =>
                    setLevels(on ? levels.filter((entry) => entry !== level) : [...levels, level])
                  }
                >
                  {severityMeta[level].label} {count}
                </button>
              );
            })}
          </div>
          <label className="search-box">
            <Icon name="search" size={14} />
            <input
              id="triage-search"
              type="search"
              placeholder="Search findings"
              aria-label="Search findings"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Kbd>/</Kbd>
          </label>
        </div>
        <div className="triage-items" ref={listRef} role="listbox" aria-label="Findings">
          {list.map((finding) => {
            const severity = severityMeta[finding.severity];
            const state = status(finding);
            return (
              <button
                key={finding.id}
                type="button"
                role="option"
                aria-selected={finding.id === current?.id}
                className={`triage-item ${finding.id === current?.id ? 'is-cursor' : ''} ${statusMeta[state].settled ? 'is-settled' : ''}`}
                onClick={() => setCursorId(finding.id)}
              >
                <i className={`sev-bar tint-${severity.tint}`} />
                <span className="ti-text">
                  <strong>{finding.title}</strong>
                  <small>
                    {fileName(finding.file)}:{finding.line} · {severity.label}
                  </small>
                </span>
                {state !== 'open' && (
                  <Pill tint={statusMeta[state].tint}>{statusMeta[state].label}</Pill>
                )}
              </button>
            );
          })}
          {list.length === 0 && (
            <div className="triage-empty">
              {isLive(session.status) ? (
                <Empty icon="sparkle" title="Your crew is still reviewing">
                  Findings appear here as soon as they’re validated.
                </Empty>
              ) : total === 0 ? (
                <Empty icon="check" title="Nothing to triage">
                  No actionable findings among the reviewed files.
                </Empty>
              ) : filter === 'todo' ? (
                <Empty icon="check" title="Everything’s decided">
                  Rerun after your fixes to confirm them.
                </Empty>
              ) : (
                <Empty icon="search" title="No matches" />
              )}
            </div>
          )}
        </div>
        <div className="triage-keys">
          <span>
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> move
          </span>
          <span>
            <Kbd>A</Kbd> will fix
          </span>
          <span>
            <Kbd>D</Kbd> dismiss
          </span>
          <span>
            <Kbd>?</Kbd> more
          </span>
        </div>
      </div>
      <div className="triage-detail no-canvas-scroll">
        {current ? (
          <FindingDetail key={current.id} finding={current} />
        ) : (
          <div className="triage-empty big">
            <Empty icon="list" title="Pick a finding">
              Use <Kbd>J</Kbd> / <Kbd>K</Kbd> to move through the list.
            </Empty>
          </div>
        )}
        {dismissing && current && (
          <div className="dismiss-sheet" role="dialog" aria-label="Dismiss reason">
            <strong>Why dismiss “{current.title}”?</strong>
            {dismissReasons.map((reason, position) => (
              <button
                key={reason.id}
                type="button"
                className="dismiss-option"
                onClick={() => {
                  setDismissing(false);
                  set(current, 'dismissed', reason.id);
                }}
              >
                <Kbd>{position + 1}</Kbd>
                <span>
                  {reason.label}
                  <small>{reason.hint}</small>
                </span>
              </button>
            ))}
            <button type="button" className="link small" onClick={() => setDismissing(false)}>
              Cancel <Kbd>esc</Kbd>
            </button>
          </div>
        )}
      </div>
      {cleared && <Celebrate total={total} />}
    </div>
  );
};
