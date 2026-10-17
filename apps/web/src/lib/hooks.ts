import {
  type DomainEvent,
  DomainEventSchema,
  type Interaction,
  type ReviewSession,
} from '@reviewlab/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, eventStream } from '../api';
import { isLive, runIdOf } from './meta';

/** Loads a session, its runs and the chosen run; polls quickly while a review is running. */
export const useSession = (id: string) => {
  const [latest, setLatest] = useState<ReviewSession | null>(null);
  const [runs, setRuns] = useState<ReviewSession[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const version = useRef(0);
  const reload = useCallback(async () => {
    const current = ++version.current;
    try {
      const [session, saved] = await Promise.all([
        api<ReviewSession>(`/sessions/${id}`),
        api<ReviewSession[]>(`/sessions/${id}/runs`),
      ]);
      if (current !== version.current) return;
      setLatest(session);
      setRuns(saved);
      setError('');
    } catch (cause) {
      if (current === version.current)
        setError(cause instanceof Error ? cause.message : 'Could not load this review');
    }
  }, [id]);
  const live = latest ? isLive(latest.status) : true;
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), live ? 1500 : 8000);
    return () => clearInterval(timer);
  }, [reload, live]);
  const active = (runId && runs.find((run) => runIdOf(run) === runId)) || latest || null;
  const historical = Boolean(active && latest && runIdOf(active) !== runIdOf(latest));
  return { latest, runs, active, historical, error, reload, chooseRun: setRunId };
};

export const useInteraction = (sessionId: string | undefined, revision: number | undefined) => {
  const [state, setState] = useState<Interaction | null>(null);
  const reload = useCallback(async () => {
    if (!sessionId) return;
    const next = await api<Interaction>(`/sessions/${sessionId}/interaction`);
    setState((previous) =>
      previous?.sessionId === next.sessionId && previous.revision > next.revision ? previous : next,
    );
  }, [sessionId]);
  useEffect(() => {
    void reload().catch(() => {});
  }, [reload, revision]);
  return { interaction: state?.sessionId === sessionId ? state : null, reloadInteraction: reload };
};

/** Server-sent review activity with resumable cursor and capped backoff. */
export const useEvents = (sessionId: string, onEvent?: () => void) => {
  const [events, setEvents] = useState<DomainEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const callback = useRef(onEvent);
  callback.current = onEvent;
  useEffect(() => {
    let alive = true;
    let cursor = 0;
    let failures = 0;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setEvents([]);
    const connect = async () => {
      try {
        const response = await eventStream(
          `/sessions/${sessionId}/events?after=${cursor}`,
          controller.signal,
        );
        if (!response.ok || !response.body) throw new Error('Progress connection failed');
        setConnected(true);
        failures = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (alive) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            if (buffer.length > 1_000_000) throw new Error('Progress event too large');
            let boundary = buffer.match(/\r?\n\r?\n/);
            while (boundary?.index !== undefined) {
              const frame = buffer.slice(0, boundary.index);
              buffer = buffer.slice(boundary.index + boundary[0].length);
              const payload = frame
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
              if (payload) {
                const event = DomainEventSchema.parse(JSON.parse(payload));
                if (event.sessionId !== sessionId) throw new Error('Invalid progress session');
                if (event.cursor > cursor) {
                  cursor = event.cursor;
                  if (alive) {
                    setEvents((previous) => [...previous, event]);
                    callback.current?.();
                  }
                }
              }
              boundary = buffer.match(/\r?\n\r?\n/);
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (alive) throw new Error('Progress connection closed');
      } catch {
        if (!alive) return;
        setConnected(false);
        failures += 1;
        reconnect = setTimeout(
          () => void connect(),
          Math.min(1000 * 2 ** Math.min(failures, 4), 15_000),
        );
      }
    };
    void connect();
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(reconnect);
    };
  }, [sessionId]);
  return { events, connected };
};

const typing = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return (
    element.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ||
    Boolean(element.closest('.monaco-editor, dialog[open] form'))
  );
};

/** Single-key and modifier shortcuts that never fire while the user is typing. */
export const useHotkeys = (
  bindings: Record<string, (event: KeyboardEvent) => void>,
  enabled = true,
) => {
  const ref = useRef(bindings);
  ref.current = bindings;
  useEffect(() => {
    if (!enabled) return;
    const handle = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = `${mod ? 'mod+' : ''}${event.shiftKey && event.key.length > 1 ? 'shift+' : ''}${event.key.toLowerCase()}`;
      const action = ref.current[key];
      if (!action) return;
      if (!mod && typing(event.target)) return;
      if (event.altKey) return;
      event.preventDefault();
      action(event);
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [enabled]);
};

export const useStoredState = <T>(key: string, initial: T) => {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage can be unavailable; the value still lives for this page.
    }
  }, [key, value]);
  return [value, setValue] as const;
};
