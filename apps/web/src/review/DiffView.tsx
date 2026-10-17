import type { Finding, ReviewSnapshot } from '@reviewlab/domain';
import { useEffect, useMemo, useState } from 'react';
import { type DiffLine, diffLines } from '../diff-lines';
import { severityMeta } from '../lib/meta';
import { Icon } from '../ui/Icon';

const pageSize = 400;

const anchorOf = (finding: Finding) => `${finding.side}:${finding.file}:${finding.line}`;

/**
 * Read-only diff with line numbers and finding pins. `focus` scrolls to and focuses an anchor;
 * `window` trims to a few lines around it for compact previews.
 */
export const DiffView = ({
  snapshot,
  path,
  findings,
  focus,
  window: around,
  onFinding,
  label,
}: {
  snapshot: ReviewSnapshot;
  path: string | null;
  findings: Finding[];
  focus?: string | null;
  window?: number;
  onFinding?: (finding: Finding) => void;
  label: string;
}) => {
  const all = useMemo(() => diffLines(snapshot, path), [snapshot, path]);
  const pins = useMemo(() => {
    const map = new Map<string, Finding[]>();
    for (const finding of findings)
      map.set(anchorOf(finding), [...(map.get(anchorOf(finding)) ?? []), finding]);
    return map;
  }, [findings]);
  const focusIndex = focus ? all.findIndex((line) => line.anchor === focus) : -1;
  const lines: DiffLine[] =
    around !== undefined && focusIndex >= 0
      ? all.slice(Math.max(0, focusIndex - around), focusIndex + around + 1)
      : all;
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(lines.length / pageSize));
  useEffect(() => {
    if (around === undefined && focusIndex >= 0) setPage(Math.floor(focusIndex / pageSize));
  }, [focusIndex, around]);
  useEffect(() => {
    if (!focus || around !== undefined) return;
    const element = document.getElementById(focus);
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    element?.focus({ preventScroll: true });
  }, [focus, page, around]);
  const visible = lines.slice(page * pageSize, (page + 1) * pageSize);
  if (!lines.length)
    return (
      <p className="muted small">No textual diff for this selection (binary or metadata only).</p>
    );
  return (
    <div className="diff-wrap">
      <div
        className="diff"
        role="region"
        tabIndex={0}
        aria-label={label}
        onKeyDown={(event) => {
          if (!event.altKey || !['j', 'k'].includes(event.key.toLowerCase())) return;
          event.preventDefault();
          const anchors = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>('[data-anchor]'),
          );
          const index = anchors.findIndex((entry) => entry === document.activeElement);
          const next =
            event.key.toLowerCase() === 'j'
              ? anchors[(index + 1) % anchors.length]
              : anchors[(index - 1 + anchors.length) % anchors.length];
          next?.focus();
          next?.scrollIntoView({ block: 'nearest' });
        }}
      >
        {visible.map((line, index) => {
          const pinned = line.anchor ? pins.get(line.anchor) : undefined;
          const showFile = !path && line.kind === 'meta' && line.text.startsWith('diff --git');
          if (showFile)
            return (
              <div key={`f${index}`} className="diff-file">
                <Icon name="file" size={13} /> {line.file}
              </div>
            );
          if (line.kind === 'meta' && (path || around !== undefined)) return null;
          return (
            <div key={line.anchor ?? `${page}:${index}`}>
              <div
                id={around === undefined ? line.anchor : undefined}
                data-anchor={line.anchor ? '' : undefined}
                tabIndex={line.anchor ? -1 : undefined}
                className={`diff-line is-${line.kind} ${line.anchor && line.anchor === focus ? 'is-focus' : ''} ${pinned ? 'is-pinned' : ''}`}
              >
                <span className="ln">{line.oldNo ?? ''}</span>
                <span className="ln">{line.newNo ?? ''}</span>
                <code>
                  {line.kind === 'hunk'
                    ? line.text.replace(/^(@@[^@]+@@).*/, '$1')
                    : line.text || ' '}
                </code>
              </div>
              {pinned?.map((finding) => (
                <button
                  key={finding.id}
                  type="button"
                  className={`diff-pin tint-${severityMeta[finding.severity].tint}`}
                  onClick={() => onFinding?.(finding)}
                  disabled={!onFinding}
                >
                  <Icon name="flag" size={12} />
                  <span>{finding.title}</span>
                  <small>{severityMeta[finding.severity].label} · suggested</small>
                </button>
              ))}
            </div>
          );
        })}
      </div>
      {pages > 1 && (
        <nav className="diff-pages" aria-label="Diff pages">
          <button
            type="button"
            className="link"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            ← Previous
          </button>
          <span>
            Page {page + 1} / {pages} · {lines.length} lines
          </span>
          <button
            type="button"
            className="link"
            disabled={page + 1 === pages}
            onClick={() => setPage(page + 1)}
          >
            Next →
          </button>
        </nav>
      )}
    </div>
  );
};
