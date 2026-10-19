import type { Interaction, WalkthroughRequest } from '@hunkyard/domain';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { type DiffLine, diffLines } from '../diff-lines';
import { useHotkeys } from '../lib/hooks';
import { ago, dirName, fileName } from '../lib/meta';
import { useWorkspace } from '../lib/workspace';
import { Icon } from '../ui/Icon';
import { Button, Dialog, Empty, Kbd, Segmented, useToast } from '../ui/primitives';
import { useReview } from './context';
import { buildHandoff, type Note, readingPath, roleTitles, type Stop } from './walkthrough-plan';

type Spot = { side: 'old' | 'new'; line: number | null };
const statusLabel = { A: 'New', D: 'Deleted', M: 'Changed', R: 'Renamed', T: 'Type' } as const;
const spotOf = (line: DiffLine): Spot | null =>
  line.kind === 'deletion' && line.oldNo
    ? { side: 'old', line: line.oldNo }
    : line.newNo && line.kind !== 'hunk' && line.kind !== 'meta'
      ? { side: 'new', line: line.newNo }
      : null;
const sameSpot = (note: Note, spot: Spot) => note.side === spot.side && note.line === spot.line;

/** Copies within the click's user activation; falls back to a hidden textarea selection. */
const copy = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
};

/**
 * The reviewer's own pass over the frozen change: files in a reading order, a reviewed mark
 * per file, line notes, and a verdict that becomes a message for the coding agent.
 */
export const Walkthrough = () => {
  const { session, interaction, historical, refresh } = useReview();
  const { act } = useWorkspace();
  const toast = useToast();
  const snapshot = session.snapshot;
  const path = useMemo(() => readingPath(snapshot), [snapshot]);
  const pass = interaction?.walkthrough;
  const reviewed = useMemo(
    () =>
      new Set(
        (pass?.reviewed ?? [])
          .filter((entry) => entry.snapshotId === snapshot.id)
          .map((entry) => entry.path),
      ),
    [pass, snapshot.id],
  );
  const notes = useMemo(
    () => (pass?.notes ?? []).filter((note) => note.snapshotId === snapshot.id),
    [pass, snapshot.id],
  );
  const verdict = (pass?.verdicts ?? []).filter((entry) => entry.snapshotId === snapshot.id).at(-1);
  const [cursor, setCursor] = useState<string>();
  useEffect(() => {
    // Resume at the first unread file once the saved walkthrough has loaded.
    if (cursor === undefined && interaction)
      setCursor(path.find((stop) => !reviewed.has(stop.path))?.path ?? path[0]?.path);
  }, [cursor, interaction, path, reviewed]);
  const current = path.find((stop) => stop.path === cursor) ?? path[0];
  const index = current ? path.indexOf(current) : -1;
  const [composing, setComposing] = useState<Spot | null>(null);
  const [finishing, setFinishing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('.is-cursor')?.scrollIntoView({ block: 'nearest' });
    setComposing(null);
  }, [current?.path]);

  const send = (request: WalkthroughRequest, success?: string) =>
    act(async () => {
      const latest = await api<Interaction>(`/sessions/${session.id}/interaction`);
      await api(`/sessions/${session.id}/walkthrough`, {
        method: 'POST',
        body: JSON.stringify({ ...request, revision: latest.revision }),
      });
      await refresh();
    }, success);
  const move = (delta: number) => {
    const next = path[Math.min(path.length - 1, Math.max(0, index + delta))];
    if (next) setCursor(next.path);
  };
  const toggle = (stop: Stop | undefined, advance = false) => {
    if (!stop || historical) return;
    const mark = !reviewed.has(stop.path);
    void send({
      action: 'review',
      revision: 0,
      snapshotId: snapshot.id,
      path: stop.path,
      reviewed: mark,
    }).then((ok) => {
      if (!ok || !mark || !advance) return;
      const next =
        path.slice(index + 1).find((entry) => !reviewed.has(entry.path)) ??
        path.find((entry) => entry !== stop && !reviewed.has(entry.path));
      if (next) setCursor(next.path);
    });
  };
  const addNote = (spot: Spot, text: string) =>
    current &&
    send({
      action: 'note',
      revision: 0,
      snapshotId: snapshot.id,
      path: current.path,
      side: spot.side,
      line: spot.line,
      text,
    }).then((ok) => ok && setComposing(null));
  const removeNote = (note: Note) =>
    void send({ action: 'remove-note', revision: 0, noteId: note.id });
  useHotkeys(
    {
      j: () => move(1),
      arrowdown: () => move(1),
      k: () => move(-1),
      arrowup: () => move(-1),
      x: () => toggle(current, true),
      n: () => !historical && setComposing({ side: 'new', line: null }),
      f: () => !historical && setFinishing(true),
    },
    !finishing && !composing,
  );

  if (!current)
    return (
      <div className="triage-empty big">
        <Empty icon="file" title="Nothing to walk through">
          This snapshot has no changed files.
        </Empty>
      </div>
    );
  const read = path.filter((stop) => reviewed.has(stop.path)).length;
  const fileNotes = notes.filter((note) => note.path === current.path);
  return (
    <div className="walk">
      <aside className="walk-list">
        <div className="walk-top">
          <div className="walk-count">
            <strong>
              {read} of {path.length} read
            </strong>
            <span>
              {notes.length
                ? `${notes.length} note${notes.length === 1 ? '' : 's'}`
                : 'No notes yet'}
            </span>
          </div>
          <div className="triage-progress" aria-hidden="true">
            <span style={{ width: `${(read / path.length) * 100}%` }} />
          </div>
          <p className="walk-hint">Each file comes before the changed files that use it.</p>
        </div>
        <div className="walk-items" ref={listRef} role="listbox" aria-label="Reading path">
          {(Object.keys(roleTitles) as Stop['role'][]).map((role) => {
            const group = path.filter((stop) => stop.role === role);
            if (!group.length) return null;
            return (
              <div key={role} className="walk-group" role="group" aria-label={roleTitles[role]}>
                <h3>
                  {roleTitles[role]} <span>{group.length}</span>
                </h3>
                {group.map((stop) => {
                  const done = reviewed.has(stop.path);
                  const count = notes.filter((note) => note.path === stop.path).length;
                  return (
                    <div
                      key={stop.path}
                      role="option"
                      tabIndex={-1}
                      aria-selected={stop === current}
                      className={`walk-item ${stop === current ? 'is-cursor' : ''} ${done ? 'is-done' : ''}`}
                      onClick={() => setCursor(stop.path)}
                      onKeyDown={(event) => event.key === 'Enter' && setCursor(stop.path)}
                    >
                      <button
                        type="button"
                        className="walk-check"
                        aria-label={done ? `Mark ${stop.path} unread` : `Mark ${stop.path} read`}
                        aria-pressed={done}
                        disabled={historical}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggle(stop);
                        }}
                      >
                        {done && <Icon name="check" size={11} />}
                      </button>
                      <span className="walk-name">
                        <strong>{fileName(stop.path)}</strong>
                        <small>{dirName(stop.path) || './'}</small>
                      </span>
                      {count > 0 && (
                        <span
                          className="walk-notes"
                          title={`${count} note${count === 1 ? '' : 's'}`}
                        >
                          <Icon name="chat" size={11} />
                          {count}
                        </span>
                      )}
                      <span
                        className={`walk-status is-${stop.status}`}
                        title={statusLabel[stop.status]}
                      >
                        {stop.status}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="walk-foot">
          {verdict && (
            <div className="walk-verdict">
              <span className={verdict.decision === 'approve' ? 'is-approve' : 'is-changes'}>
                {verdict.decision === 'approve' ? 'Approved' : 'Changes requested'}
              </span>
              <small>{ago(verdict.createdAt)}</small>
              <button
                type="button"
                className="link small"
                onClick={async () => {
                  const copied = await copy(verdict.handoff);
                  toast(copied ? 'Handoff copied' : 'Copy failed', copied ? 'success' : 'error');
                }}
              >
                Copy again
              </button>
            </div>
          )}
          <Button
            variant="primary"
            icon="check"
            kbd="F"
            disabled={historical}
            onClick={() => setFinishing(true)}
          >
            Finish review
          </Button>
          <div className="triage-keys">
            <span>
              <Kbd>J</Kbd>
              <Kbd>K</Kbd> move
            </span>
            <span>
              <Kbd>X</Kbd> read &amp; next
            </span>
            <span>
              <Kbd>N</Kbd> file note
            </span>
          </div>
        </div>
      </aside>
      <section className="walk-detail no-canvas-scroll" aria-label={current.path}>
        <header className="walk-head">
          <div>
            <h2>
              <span>{dirName(current.path)}</span>
              {fileName(current.path)}
            </h2>
            <p>
              <span>{statusLabel[current.status]}</span>
              <span className="add">+{current.added}</span>
              <span className="del">−{current.removed}</span>
              <span>
                {index + 1} / {path.length}
              </span>
            </p>
          </div>
          <div className="walk-actions">
            <Button
              variant="ghost"
              size="sm"
              icon="chat"
              disabled={historical}
              onClick={() => setComposing({ side: 'new', line: null })}
            >
              Note on file
            </Button>
            <Button
              variant={reviewed.has(current.path) ? 'soft' : 'primary'}
              size="sm"
              icon="check"
              kbd="X"
              disabled={historical}
              onClick={() => toggle(current, true)}
            >
              {reviewed.has(current.path) ? 'Read' : 'Mark read'}
            </Button>
          </div>
        </header>
        {(current.uses.length > 0 || current.usedBy.length > 0) && (
          <div className="walk-links">
            {current.uses.length > 0 && (
              <Links label="Uses" paths={current.uses} onPick={setCursor} reviewed={reviewed} />
            )}
            {current.usedBy.length > 0 && (
              <Links
                label="Used by"
                paths={current.usedBy}
                onPick={setCursor}
                reviewed={reviewed}
              />
            )}
          </div>
        )}
        {(fileNotes.some((note) => note.line === null) || composing?.line === null) && (
          <div className="walk-file-notes">
            {fileNotes
              .filter((note) => note.line === null)
              .map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  onRemove={historical ? undefined : removeNote}
                />
              ))}
            {composing?.line === null && (
              <Composer
                label="Note on the whole file"
                onCancel={() => setComposing(null)}
                onSave={(text) => addNote(composing, text)}
              />
            )}
          </div>
        )}
        <FileDiff
          key={current.path}
          lines={diffLines(snapshot, current.path)}
          notes={fileNotes.filter((note) => note.line !== null)}
          composing={composing?.line !== null ? composing : null}
          onCompose={historical ? undefined : setComposing}
          onCancel={() => setComposing(null)}
          onSave={(spot, text) => addNote(spot, text)}
          onRemove={historical ? undefined : removeNote}
        />
        {index < path.length - 1 && (
          <button type="button" className="walk-next" onClick={() => move(1)}>
            Next: <strong>{path[index + 1]?.path}</strong>
            <Icon name="arrowRight" size={14} />
          </button>
        )}
      </section>
      {finishing && (
        <Finish
          path={path}
          notes={notes}
          unread={path.length - read}
          onClose={() => setFinishing(false)}
          onSubmit={async (decision, handoff) => {
            // Copy first: the clipboard needs the click's activation, which a request would outlast.
            const copied = await copy(handoff);
            const ok = await send({
              action: 'verdict',
              revision: 0,
              snapshotId: snapshot.id,
              decision,
              handoff,
            });
            if (!ok) return;
            setFinishing(false);
            toast(
              copied
                ? 'Copied. Paste it to your coding agent.'
                : 'Saved, but copying failed. Use Copy again.',
              copied ? 'success' : 'error',
            );
          }}
        />
      )}
    </div>
  );
};

const Links = ({
  label,
  paths,
  onPick,
  reviewed,
}: {
  label: string;
  paths: string[];
  onPick: (path: string) => void;
  reviewed: Set<string>;
}) => (
  <div className="walk-link-row">
    <span>{label}</span>
    {paths.map((path) => (
      <button
        key={path}
        type="button"
        className={`chip ${reviewed.has(path) ? 'is-read' : ''}`}
        title={path}
        onClick={() => onPick(path)}
      >
        {reviewed.has(path) && <Icon name="check" size={11} />}
        {fileName(path)}
      </button>
    ))}
  </div>
);

const NoteCard = ({
  note,
  onRemove,
}: {
  note: Note;
  onRemove?: ((note: Note) => void) | undefined;
}) => (
  <div className="walk-note">
    <Icon name="chat" size={12} />
    <p>{note.text}</p>
    {onRemove && (
      <button
        type="button"
        className="icon-btn"
        aria-label="Delete note"
        onClick={() => onRemove(note)}
      >
        <Icon name="trash" size={12} />
      </button>
    )}
  </div>
);

const Composer = ({
  label,
  onSave,
  onCancel,
}: {
  label: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) => {
  const [text, setText] = useState('');
  const save = () => text.trim() && onSave(text.trim());
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') onCancel();
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
  };
  return (
    <div className="walk-composer">
      <textarea
        autoFocus
        aria-label={label}
        placeholder="What should the agent change here?"
        value={text}
        maxLength={4000}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={keys}
      />
      <div>
        <button type="button" className="link small" onClick={onCancel}>
          Cancel
        </button>
        <Button size="sm" variant="primary" disabled={!text.trim()} onClick={save}>
          Add note <Kbd>⌘↵</Kbd>
        </Button>
      </div>
    </div>
  );
};

const FileDiff = ({
  lines,
  notes,
  composing,
  onCompose,
  onCancel,
  onSave,
  onRemove,
}: {
  lines: DiffLine[];
  notes: Note[];
  composing: Spot | null;
  onCompose?: ((spot: Spot) => void) | undefined;
  onCancel: () => void;
  onSave: (spot: Spot, text: string) => void;
  onRemove?: ((note: Note) => void) | undefined;
}) => {
  const shown = lines.filter((line) => line.kind !== 'meta');
  if (!shown.length)
    return <p className="muted small">No textual diff for this file (binary or metadata only).</p>;
  return (
    <div className="diff walk-diff" role="region" aria-label="File diff">
      {shown.map((line, position) => {
        const spot = spotOf(line);
        const here = spot ? notes.filter((note) => sameSpot(note, spot)) : [];
        const open =
          spot && composing && composing.side === spot.side && composing.line === spot.line;
        return (
          <div key={`${position}:${line.anchor ?? ''}`}>
            <div className={`diff-line walk-line is-${line.kind} ${here.length ? 'has-note' : ''}`}>
              <span className="ln">{line.oldNo ?? ''}</span>
              <span className="ln">{line.newNo ?? ''}</span>
              {spot && onCompose ? (
                <button
                  type="button"
                  className="walk-add"
                  aria-label={`Add note on line ${spot.line}`}
                  onClick={() => onCompose(spot)}
                >
                  <Icon name="plus" size={11} />
                </button>
              ) : (
                <span />
              )}
              <code>
                {line.kind === 'hunk'
                  ? line.text.replace(/^(@@[^@]+@@).*/, '$1')
                  : line.text || ' '}
              </code>
            </div>
            {here.map((note) => (
              <div key={note.id} className="walk-inline">
                <NoteCard note={note} onRemove={onRemove} />
              </div>
            ))}
            {open && spot && (
              <div className="walk-inline">
                <Composer
                  label={`Note on line ${spot.line}`}
                  onCancel={onCancel}
                  onSave={(text) => onSave(spot, text)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

const Finish = ({
  path,
  notes,
  unread,
  onClose,
  onSubmit,
}: {
  path: Stop[];
  notes: Note[];
  unread: number;
  onClose: () => void;
  onSubmit: (decision: 'approve' | 'request-changes', handoff: string) => Promise<void>;
}) => {
  const { session } = useReview();
  const [decision, setDecision] = useState<'approve' | 'request-changes'>(
    notes.length ? 'request-changes' : 'approve',
  );
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const handoff = buildHandoff(session.snapshot, path, notes, decision, summary);
  const empty = decision === 'request-changes' && !notes.length && !summary.trim();
  return (
    <Dialog
      title="Finish review"
      wide
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="copy"
            disabled={busy || empty}
            onClick={async () => {
              setBusy(true);
              await onSubmit(decision, handoff);
              setBusy(false);
            }}
          >
            Save &amp; copy for agent
          </Button>
        </>
      }
    >
      <div className="walk-finish">
        <Segmented
          label="Verdict"
          value={decision}
          onChange={setDecision}
          options={[
            { id: 'request-changes', label: `Request changes · ${notes.length}`, icon: 'chat' },
            { id: 'approve', label: 'Approve', icon: 'check' },
          ]}
        />
        {unread > 0 && (
          <p className="note">
            {unread} of {path.length} files are not marked read yet.
          </p>
        )}
        {empty && <p className="note">Add notes or a summary so the agent knows what to change.</p>}
        <textarea
          aria-label="Summary for the agent"
          placeholder={
            decision === 'approve'
              ? 'Optional: anything to tell the agent'
              : 'Optional: the overall direction, before the line notes'
          }
          value={summary}
          maxLength={8000}
          onChange={(event) => setSummary(event.target.value)}
        />
        <div className="walk-preview">
          <span>Message for the agent</span>
          <pre>{handoff}</pre>
        </div>
      </div>
    </Dialog>
  );
};
