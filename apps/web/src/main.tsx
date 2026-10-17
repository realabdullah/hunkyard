import React, { useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { hasToken, setToken } from './api';
import { Launchpad } from './launch/Launchpad';
import { useHotkeys, useStoredState } from './lib/hooks';
import { sessionTitle } from './lib/meta';
import { initTheme } from './lib/theme';
import { useWorkspace, WorkspaceProvider } from './lib/workspace';
import { ReviewView } from './review/ReviewView';
import { SettingsView } from './settings/SettingsView';
import { type Command, CommandPalette, ShortcutHelp } from './shell/CommandPalette';
import { Connect } from './shell/Connect';
import { Sidebar } from './shell/Sidebar';
import { TabBar } from './shell/TabBar';
import { ToastProvider } from './ui/primitives';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/launch.css';
import './styles/board.css';
import './styles/panel.css';
import './styles/triage.css';
import './styles/settings.css';

const Shell = () => {
  const { view, go, sessions, disconnect } = useWorkspace();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [hidden, setHidden] = useStoredState('reviewlab.sidebarHidden', false);
  useHotkeys({
    'mod+k': () => setPalette((open) => !open),
    n: () => go({ kind: 'home' }),
    '?': () => setHelp(true),
    'mod+\\': () => setHidden((value) => !value),
  });
  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'new',
        label: 'New review',
        icon: 'plus',
        group: 'Go to',
        kbd: 'N',
        run: () => go({ kind: 'home' }),
      },
      {
        id: 'settings',
        label: 'Models & privacy',
        icon: 'gear',
        group: 'Go to',
        run: () => go({ kind: 'settings' }),
      },
      {
        id: 'help',
        label: 'Keyboard shortcuts',
        icon: 'keyboard',
        group: 'Go to',
        kbd: '?',
        run: () => setHelp(true),
      },
      ...sessions.map(
        (session): Command => ({
          id: session.id,
          label: sessionTitle(session),
          hint: `${new Date(session.createdAt).toLocaleString()} · ${session.status}`,
          icon: 'board',
          group: 'Reviews',
          run: () => go({ kind: 'review', id: session.id }),
        }),
      ),
      {
        id: 'disconnect',
        label: 'Disconnect this tab',
        icon: 'close',
        group: 'Session',
        run: disconnect,
      },
    ],
    [sessions, go, disconnect],
  );
  return (
    <div className={`shell ${hidden ? 'sidebar-hidden' : ''}`}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {!hidden && <Sidebar openPalette={() => setPalette(true)} collapse={() => setHidden(true)} />}
      <div className="stage">
        <TabBar
          sidebarHidden={hidden}
          showSidebar={() => setHidden(false)}
          showHelp={() => setHelp(true)}
        />
        <main className="stage-body" id="main-content" tabIndex={-1}>
          {view.kind === 'home' && <Launchpad />}
          {view.kind === 'settings' && <SettingsView />}
          {view.kind === 'review' && <ReviewView key={view.id} id={view.id} />}
        </main>
      </div>
      {palette && <CommandPalette commands={commands} close={() => setPalette(false)} />}
      {help && <ShortcutHelp close={() => setHelp(false)} />}
    </div>
  );
};

const App = () => {
  const [connected, setConnected] = useState(hasToken());
  const disconnect = useCallback(() => {
    setToken('');
    setConnected(false);
  }, []);
  return (
    <ToastProvider>
      {connected ? (
        <WorkspaceProvider disconnect={disconnect}>
          <Shell />
        </WorkspaceProvider>
      ) : (
        <Connect
          connect={(token) => {
            setToken(token);
            setConnected(true);
          }}
        />
      )}
    </ToastProvider>
  );
};

initTheme();
const root = document.getElementById('root');
if (!root) throw new Error('ReviewLab root element is missing.');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
