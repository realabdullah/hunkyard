import { useEffect, useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

const key = 'hunkyard.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

const read = (): ThemePreference => {
  try {
    const value = localStorage.getItem(key);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
};

let preference = read();

const apply = () => {
  if (preference === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = preference;
};

/** Applies the saved preference before first paint. */
export const initTheme = apply;

export const setTheme = (next: ThemePreference) => {
  preference = next;
  try {
    if (next === 'system') localStorage.removeItem(key);
    else localStorage.setItem(key, next);
  } catch {
    // Storage can be unavailable; the choice still applies for this tab.
  }
  apply();
  for (const listener of listeners) listener();
};

/** Whether the interface currently renders dark, resolving `system` against the OS. */
export const isDark = () => (preference === 'system' ? media.matches : preference === 'dark');

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  media.addEventListener('change', listener);
  return () => {
    listeners.delete(listener);
    media.removeEventListener('change', listener);
  };
};

export const useTheme = () => {
  const current = useSyncExternalStore(subscribe, () => preference);
  const dark = useSyncExternalStore(subscribe, isDark);
  useEffect(apply, []);
  return { preference: current, dark, setTheme };
};
