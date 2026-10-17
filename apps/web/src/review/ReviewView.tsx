import { useCallback, useMemo, useState } from 'react';
import { api } from '../api';
import { useEvents, useHotkeys, useInteraction, useSession, useStoredState } from '../lib/hooks';
import { isLive, runIdOf, scopeMeta, sessionTitle, shortSha, statusMeta } from '../lib/meta';
import { useWorkspace } from '../lib/workspace';
import { Icon } from '../ui/Icon';
import { Button, Dialog, Field, Kbd, Menu, MenuItem, Segmented, Switch } from '../ui/primitives';
import { Board } from './Board';
import { makeStatus, ReviewContext, type ReviewCtx, type Selection, useReview } from './context';
import { SidePanel } from './panels/SidePanel';
import { Triage } from './Triage';

export const ReviewView = ({ id }: { id: string }) => {
  const { latest, runs, active, historical, error, reload, chooseRun } = useSession(id);
  const { interaction, reloadInteraction } = useInteraction(active?.id, active?.revision);
  const { events } = useEvents(id, () => void reload());
  const [mode, setMode] = useStoredState<'board' | 'triage'>('hunkyard.mode', 'board');
  const [selection, setSelection] = useState<Selection | null>(null);
  const refresh = useCallback(async () => {
    await Promise.all([reload(), reloadInteraction()]);
  }, [reload, reloadInteraction]);
  useHotkeys({
    b: () => setMode('board'),
    t: () => setMode('triage'),
    escape: () => setSelection(null),
  });
  const ctx = useMemo<ReviewCtx | null>(
    () =>
      active && latest
        ? {
            session: active,
            latest,
            runs,
            interaction,
            historical,
            events,
            selection,
            select: setSelection,
            refresh,
            status: makeStatus(interaction, active),
          }
        : null,
    [active, latest, runs, interaction, historical, events, selection, refresh],
  );
  if (!ctx)
    return (
      <div className="review-loading">
        {error ? (
          <p className="note is-error">{error}</p>
        ) : (
          <>
            <span className="loader" />
            <p>Opening board…</p>
          </>
        )}
      </div>
    );
  return (
    <ReviewContext.Provider value={ctx}>
      <div className="review">
        <ReviewHeader mode={mode} setMode={setMode} chooseRun={chooseRun} />
        <div className="review-body">
          {mode === 'board' ? <Board /> : <Triage />}
          {selection && mode === 'board' && <SidePanel />}
          {selection && mode === 'triage' && selection.kind !== 'finding' && <SidePanel />}
        </div>
      </div>
    </ReviewContext.Provider>
  );
};

const ReviewHeader = ({
  mode,
  setMode,
  chooseRun,
}: {
  mode: 'board' | 'triage';
  setMode: (mode: 'board' | 'triage') => void;
  chooseRun: (id: string | null) => void;
}) => {
  const { session, latest, runs, historical, status, refresh, select } = useReview();
  const { act, busy, go, closeTab, reload } = useWorkspace();
  const [dialog, setDialog] = useState<'rerun' | 'export' | 'delete' | null>(null);
  const settled = session.findings.filter((finding) => statusMeta[status(finding)].settled).length;
  const total = session.findings.length;
  const live = isLive(latest.status);
  const ordered = [...runs].sort(
    (a, b) =>
      new Date(b.startedAt ?? b.createdAt).getTime() -
      new Date(a.startedAt ?? a.createdAt).getTime(),
  );
  const runIndex = ordered.findIndex((run) => runIdOf(run) === runIdOf(session));
  return (
    <>
      <header className="review-head">
        <div className="review-title">
          <h1>{sessionTitle(session)}</h1>
          <p>
            <span>{scopeMeta[session.snapshot.scope].title}</span>
            <span>{session.snapshot.files.length} files</span>
            <span title={session.snapshot.headSha ?? 'Unborn HEAD'}>
              HEAD {shortSha(session.snapshot.headSha)}
            </span>
            <span>Frozen {new Date(session.snapshot.createdAt).toLocaleString()}</span>
          </p>
        </div>
        <div className="review-tools">
          {total > 0 && (
            <div className="progress-pill" title={`${settled} of ${total} findings decided`}>
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="10" r="8" className="track" />
                <circle
                  cx="10"
                  cy="10"
                  r="8"
                  className="value"
                  strokeDasharray={`${(settled / total) * 50.27} 50.27`}
                />
              </svg>
              <span>
                {settled}/{total} decided
              </span>
            </div>
          )}
          {runs.length > 1 && (
            <Menu
              trigger={(props) => (
                <button type="button" className="btn btn-ghost btn-sm" {...props}>
                  <Icon name="history" size={14} />
                  Run {ordered.length - runIndex} of {ordered.length}
                  <Icon name="chevronDown" size={12} />
                </button>
              )}
            >
              {(close) =>
                ordered.map((run, index) => (
                  <MenuItem
                    key={runIdOf(run)}
                    icon={runIdOf(run) === runIdOf(session) ? 'check' : 'history'}
                    hint={`${run.status} · ${run.findings.length} findings`}
                    onClick={() => {
                      chooseRun(index === 0 ? null : runIdOf(run));
                      close();
                    }}
                  >
                    Run {ordered.length - index} ·{' '}
                    {new Date(run.startedAt ?? run.createdAt).toLocaleString()}
                    {index === 0 ? ' (latest)' : ''}
                  </MenuItem>
                ))
              }
            </Menu>
          )}
          <Segmented
            label="View"
            value={mode}
            onChange={setMode}
            options={[
              { id: 'board', label: 'Board', icon: 'board' },
              { id: 'triage', label: 'Triage', icon: 'list' },
            ]}
          />
          <Button variant="ghost" size="sm" icon="chat" onClick={() => select({ kind: 'chat' })}>
            Discuss
          </Button>
          <Menu
            trigger={(props) => (
              <button type="button" className="icon-btn" aria-label="Review actions" {...props}>
                <Icon name="more" />
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuItem
                  icon="refresh"
                  disabled={busy || live || historical}
                  hint="Same frozen code, current settings"
                  onClick={() => {
                    close();
                    void act(async () => {
                      await api(`/sessions/${latest.id}/runs`, {
                        method: 'POST',
                        body: JSON.stringify({ revision: latest.revision, recapture: false }),
                      });
                      chooseRun(null);
                      await refresh();
                    }, 'Rerun started');
                  }}
                >
                  Rerun this snapshot
                </MenuItem>
                <MenuItem
                  icon="snowflake"
                  disabled={busy || live || historical || Boolean(latest.snapshot.pullRequest)}
                  hint="Freeze your latest changes, then review"
                  onClick={() => {
                    close();
                    setDialog('rerun');
                  }}
                >
                  Capture again & rerun…
                </MenuItem>
                <MenuItem
                  icon="eye"
                  hint="Provenance, context & rules"
                  onClick={() => {
                    close();
                    select({ kind: 'evidence' });
                  }}
                >
                  Evidence & provenance
                </MenuItem>
                <MenuItem
                  icon="pulse"
                  onClick={() => {
                    close();
                    select({ kind: 'activity' });
                  }}
                >
                  Activity log
                </MenuItem>
                <MenuItem
                  icon="download"
                  onClick={() => {
                    close();
                    setDialog('export');
                  }}
                >
                  Export…
                </MenuItem>
                <MenuItem
                  icon="trash"
                  danger
                  disabled={live}
                  onClick={() => {
                    close();
                    setDialog('delete');
                  }}
                >
                  Delete review…
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      </header>
      {historical && (
        <div className="banner is-info">
          <Icon name="history" size={15} />
          <span>
            You’re viewing an older run. Its findings stay pinned to the code it saw. Decisions
            happen on the latest run.
          </span>
          <Button size="sm" variant="ghost" onClick={() => chooseRun(null)}>
            Back to latest
          </Button>
        </div>
      )}
      {live && !historical && (
        <div className="banner is-live">
          <span className="loader small" />
          <span>
            <strong>{latest.status === 'queued' ? 'Queued' : 'Reviewing'}</strong> — your crew is
            reading the frozen snapshot. Findings land on the board as soon as they’re validated.
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api(`/sessions/${latest.id}/cancel`, { method: 'POST' });
                await refresh();
              }, 'Review cancelled')
            }
          >
            Cancel review
          </Button>
        </div>
      )}
      {session.error && (
        <div className="banner is-error" role="alert">
          <Icon name="flag" size={15} />
          <span>{session.error}</span>
          <Button size="sm" variant="ghost" onClick={() => select({ kind: 'activity' })}>
            See activity
          </Button>
        </div>
      )}
      {dialog === 'rerun' && (
        <RecaptureDialog close={() => setDialog(null)} chooseRun={chooseRun} />
      )}
      {dialog === 'export' && <ExportDialog close={() => setDialog(null)} />}
      {dialog === 'delete' && (
        <Dialog
          title="Delete this review?"
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(null)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api(`/sessions/${latest.id}`, {
                      method: 'DELETE',
                      body: JSON.stringify({ revision: latest.revision }),
                    });
                    setDialog(null);
                    closeTab(latest.id);
                    go({ kind: 'home' });
                    await reload();
                  }, 'Review deleted')
                }
              >
                Permanently delete
              </Button>
            </>
          }
        >
          <p>
            This removes all {runs.length} saved run{runs.length === 1 ? '' : 's'}, findings, notes
            and unreferenced snapshots for this review. It can’t be undone.{' '}
            <strong>Your repository files are not touched.</strong>
          </p>
        </Dialog>
      )}
    </>
  );
};

const RecaptureDialog = ({
  close,
  chooseRun,
}: {
  close: () => void;
  chooseRun: (id: string | null) => void;
}) => {
  const { latest, refresh } = useReview();
  const { act, busy } = useWorkspace();
  const [paths, setPaths] = useState('');
  return (
    <Dialog
      title="Capture again & rerun"
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const list = paths
                  .split(/[\n,]/)
                  .map((path) => path.trim())
                  .filter(Boolean);
                await api(`/sessions/${latest.id}/runs`, {
                  method: 'POST',
                  body: JSON.stringify({
                    revision: latest.revision,
                    recapture: true,
                    ...(list.length ? { paths: list } : {}),
                  }),
                });
                close();
                chooseRun(null);
                await refresh();
              }, 'New snapshot captured; review started')
            }
          >
            <Icon name="snowflake" size={14} /> Capture & review
          </Button>
        </>
      }
    >
      <p>
        Freezes your current <strong>{scopeMeta[latest.snapshot.scope].title.toLowerCase()}</strong>{' '}
        as a new snapshot and reviews it with today’s model settings. Earlier runs keep their own
        evidence, and findings are matched across runs.
      </p>
      <Field label="Only these paths (optional)" hint="Leave empty to recapture the whole scope.">
        <textarea rows={3} value={paths} onChange={(event) => setPaths(event.target.value)} />
      </Field>
    </Dialog>
  );
};

const ExportDialog = ({ close }: { close: () => void }) => {
  const { latest } = useReview();
  const { act, busy } = useWorkspace();
  const [source, setSource] = useState(false);
  return (
    <Dialog
      title="Export review"
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="download"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const exported = await api<unknown>(`/sessions/${latest.id}/export`, {
                  method: 'POST',
                  body: JSON.stringify({ includeSource: source }),
                });
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }),
                );
                const link = document.createElement('a');
                link.href = url;
                link.download = `hunkyard-${latest.id}${source ? '-source' : '-diagnostic'}.json`;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                close();
              })
            }
          >
            Download JSON
          </Button>
        </>
      }
    >
      <p>
        Saves a local JSON file. By default it’s a redacted diagnostic export without your code.
      </p>
      <Switch
        checked={source}
        onChange={setSource}
        label="Include source code and instructions"
        hint="May contain private code or secrets. Only share it with people you trust."
      />
      <p className="muted small">
        <Kbd>Tip</Kbd> Exports never leave your machine unless you send the file somewhere.
      </p>
    </Dialog>
  );
};
