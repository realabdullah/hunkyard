import { isLive, sessionTitle } from '../lib/meta';
import { type ThemePreference, useTheme } from '../lib/theme';
import { useWorkspace } from '../lib/workspace';
import { Icon, type IconName } from '../ui/Icon';
import { IconButton } from '../ui/primitives';

export const TabBar = ({
  sidebarHidden,
  showSidebar,
  showHelp,
}: {
  sidebarHidden: boolean;
  showSidebar: () => void;
  showHelp: () => void;
}) => {
  const { tabs, sessions, view, go, closeTab } = useWorkspace();
  return (
    <div className="tabbar">
      {sidebarHidden && <IconButton icon="sidebar" label="Show sidebar" onClick={showSidebar} />}
      <div className="tabs" role="tablist" aria-label="Open boards">
        <button
          type="button"
          role="tab"
          aria-selected={view.kind === 'home'}
          className={`tab tab-home ${view.kind === 'home' ? 'is-active' : ''}`}
          onClick={() => go({ kind: 'home' })}
        >
          <Icon name="home" size={14} />
          <span>Home</span>
        </button>
        {tabs.map((id) => {
          const session = sessions.find((entry) => entry.id === id);
          if (!session) return null;
          const active = view.kind === 'review' && view.id === id;
          return (
            <div key={id} className={`tab ${active ? 'is-active' : ''}`}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="tab-main"
                onClick={() => go({ kind: 'review', id })}
                onAuxClick={(event) => {
                  if (event.button === 1) closeTab(id);
                }}
              >
                <Icon
                  name={isLive(session.status) ? 'pulse' : 'board'}
                  size={14}
                  className={isLive(session.status) ? 'spin-pulse' : ''}
                />
                <span>{sessionTitle(session)}</span>
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${sessionTitle(session)}`}
                onClick={() => closeTab(id)}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <ThemeSwitch />
      <IconButton icon="keyboard" label="Keyboard shortcuts (?)" onClick={showHelp} />
    </div>
  );
};

const themes: { id: ThemePreference; label: string; icon: IconName }[] = [
  { id: 'system', label: 'Match system theme', icon: 'monitor' },
  { id: 'light', label: 'Light theme', icon: 'sun' },
  { id: 'dark', label: 'Dark theme', icon: 'moon' },
];

const ThemeSwitch = () => {
  const { preference, setTheme } = useTheme();
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme">
      {themes.map((theme) => (
        <button
          key={theme.id}
          type="button"
          role="radio"
          aria-checked={preference === theme.id}
          aria-label={theme.label}
          title={theme.label}
          className={preference === theme.id ? 'is-on' : ''}
          onClick={() => setTheme(theme.id)}
        >
          <Icon name={theme.icon} size={14} />
        </button>
      ))}
    </div>
  );
};
