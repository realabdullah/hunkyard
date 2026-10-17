import type { SessionSummary } from '@reviewlab/domain';
import { useMemo } from 'react';
import { ago, isLive, providerMeta, sessionTitle } from '../lib/meta';
import { useWorkspace } from '../lib/workspace';
import { Icon, type IconName } from '../ui/Icon';
import { IconButton, Kbd } from '../ui/primitives';

const groupOf = (iso: string) => {
  const days = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  if (days < 1 && new Date(iso).getDate() === new Date().getDate()) return 'Today';
  if (days < 7) return 'This week';
  return 'Earlier';
};

const statusIcon = (session: SessionSummary) =>
  isLive(session.status) ? 'is-live' : session.status === 'failed' ? 'is-failed' : '';

export const Sidebar = ({
  openPalette,
  collapse,
}: {
  openPalette: () => void;
  collapse: () => void;
}) => {
  const { sessions, target, view, go, name } = useWorkspace();
  const groups = useMemo(() => {
    const map = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      const key = groupOf(session.createdAt);
      map.set(key, [...(map.get(key) ?? []), session]);
    }
    return [...map];
  }, [sessions]);
  const nav: { id: 'home' | 'settings'; label: string; icon: IconName }[] = [
    { id: 'home', label: 'New review', icon: 'plus' },
    { id: 'settings', label: 'Models & privacy', icon: 'gear' },
  ];
  const local = target?.privacy !== 'cloud-allowed';
  return (
    <nav className="sidebar" aria-label="Workspace">
      <div className="sidebar-head">
        <span className="brand-mark" aria-hidden="true">
          R
        </span>
        <div className="sidebar-repo">
          <strong>{name || 'This repository'}</strong>
          <small>ReviewLab</small>
        </div>
        <IconButton icon="sidebar" label="Hide sidebar" onClick={collapse} />
      </div>
      <button type="button" className="sidebar-search" onClick={openPalette}>
        <Icon name="search" size={14} />
        <span>Search & commands</span>
        <Kbd>⌘K</Kbd>
      </button>
      <div className="sidebar-nav">
        {nav.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-item ${view.kind === item.id ? 'is-active' : ''}`}
            aria-current={view.kind === item.id ? 'page' : undefined}
            onClick={() => go({ kind: item.id })}
          >
            <Icon name={item.icon} />
            {item.label}
            {item.id === 'home' && <Kbd>N</Kbd>}
          </button>
        ))}
      </div>
      <div className="sidebar-section">
        <div className="sidebar-label">
          Reviews <span>{sessions.length}</span>
        </div>
        {sessions.length === 0 && (
          <p className="sidebar-empty">Your reviews will collect here, each one a board.</p>
        )}
        {groups.map(([group, list]) => (
          <div key={group} className="sidebar-group">
            <div className="sidebar-sub">{group}</div>
            {list.map((session) => {
              const active = view.kind === 'review' && view.id === session.id;
              return (
                <button
                  key={session.id}
                  type="button"
                  className={`session-item ${active ? 'is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => go({ kind: 'review', id: session.id })}
                >
                  <span className={`session-dot ${statusIcon(session)}`} />
                  <span className="session-text">
                    <span className="session-name">{sessionTitle(session)}</span>
                    <small>
                      {isLive(session.status)
                        ? 'Reviewing…'
                        : session.status === 'completed'
                          ? ago(session.createdAt)
                          : session.status}
                    </small>
                  </span>
                  {session.findingCount ? (
                    <span className="session-count" title={`${session.findingCount} findings`}>
                      {session.findingCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {target && (
        <button
          type="button"
          className={`privacy-chip ${local ? 'is-local' : 'is-cloud'}`}
          onClick={() => go({ kind: 'settings' })}
        >
          <Icon name={local ? 'lock' : 'cloud'} />
          <span>
            <strong>{local ? 'Local only' : 'Cloud allowed'}</strong>
            <small>
              {providerMeta[target.provider].name} · {target.model || 'no model'}
            </small>
          </span>
        </button>
      )}
    </nav>
  );
};
