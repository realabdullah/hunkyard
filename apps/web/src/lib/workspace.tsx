import type { ModelTarget, SessionSummary } from '@hunkyard/domain';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from '../api';
import { useToast } from '../ui/primitives';
import { useStoredState } from './hooks';

export type View = { kind: 'home' } | { kind: 'settings' } | { kind: 'review'; id: string };

type Workspace = {
  target: ModelTarget | null;
  /** Repository folder name, for display only. */
  name: string;
  sessions: SessionSummary[];
  reload: () => Promise<void>;
  busy: boolean;
  /** Runs a mutation with a shared busy flag; failures surface as toasts and resolve false. */
  act: (operation: () => Promise<void>, success?: string) => Promise<boolean>;
  view: View;
  go: (view: View) => void;
  tabs: string[];
  closeTab: (id: string) => void;
  disconnect: () => void;
};

const Context = createContext<Workspace | null>(null);
export const useWorkspace = () => {
  const value = useContext(Context);
  if (!value) throw new Error('Workspace context missing');
  return value;
};

export const WorkspaceProvider = ({
  children,
  disconnect,
}: {
  children: ReactNode;
  disconnect: () => void;
}) => {
  const toast = useToast();
  const [target, setTarget] = useState<ModelTarget | null>(null);
  const [name, setName] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>({ kind: 'home' });
  const [tabs, setTabs] = useStoredState<string[]>('hunkyard.tabs', []);
  const failures = useRef(0);
  const reload = useCallback(async () => {
    try {
      const [history, health] = await Promise.all([
        api<SessionSummary[]>('/sessions'),
        api<{ target: ModelTarget; name?: string | null }>('/health'),
      ]);
      setSessions(history);
      setTarget(health.target);
      setName(health.name ?? '');
      setTabs((open) => open.filter((id) => history.some((session) => session.id === id)));
      failures.current = 0;
    } catch (error) {
      failures.current += 1;
      if (failures.current === 2)
        toast(error instanceof Error ? error.message : 'Lost connection to Hunkyard', 'error');
    }
  }, [toast, setTabs]);
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 4000);
    return () => clearInterval(timer);
  }, [reload]);
  const act = useCallback(
    async (operation: () => Promise<void>, success?: string) => {
      setBusy(true);
      try {
        await operation();
        if (success) toast(success, 'success');
        return true;
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Request failed', 'error');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  const go = useCallback(
    (next: View) => {
      setView(next);
      if (next.kind === 'review')
        setTabs((open) => (open.includes(next.id) ? open : [...open, next.id].slice(-8)));
    },
    [setTabs],
  );
  const closeTab = useCallback(
    (id: string) => {
      setTabs((open) => open.filter((entry) => entry !== id));
      setView((current) =>
        current.kind === 'review' && current.id === id ? { kind: 'home' } : current,
      );
    },
    [setTabs],
  );
  const value = useMemo(
    () => ({ target, name, sessions, reload, busy, act, view, go, tabs, closeTab, disconnect }),
    [target, name, sessions, reload, busy, act, view, go, tabs, closeTab, disconnect],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
};
