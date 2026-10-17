let token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
export const hasToken = () => Boolean(token);
export const setToken = (value: string) => {
  token = value.trim();
};
export const eventStream = (path: string, signal: AbortSignal) => {
  if (!token)
    return Promise.reject(new Error('Connect to the local workspace to receive progress'));
  return fetch(`/api/v1${path}`, {
    headers: { authorization: `Bearer ${token}`, 'x-reviewlab-csrf': '1' },
    signal,
  });
};
export const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'x-reviewlab-csrf': '1',
      'content-type': 'application/json',
      ...init?.headers,
    },
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const problem = data as { title?: string; error?: string };
    throw new Error(problem.title ?? problem.error ?? 'Request failed');
  }
  return data as T;
};
