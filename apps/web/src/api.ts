const launchParams = new URLSearchParams(window.location.hash.slice(1));
let token = launchParams.get('token') ?? '';
/** Session the CLI asked to open on first load (`hunkyard review --walkthrough`). */
export const launchSession = /^[0-9a-f-]{36}$/i.test(launchParams.get('session') ?? '')
  ? launchParams.get('session')
  : null;
if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
export const hasToken = () => Boolean(token);
export const setToken = (value: string) => {
  token = value.trim();
};
export const eventStream = (path: string, signal: AbortSignal, init?: RequestInit) => {
  if (!token)
    return Promise.reject(new Error('Connect to the local workspace to receive progress'));
  return fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'x-hunkyard-csrf': '1',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    signal,
  });
};

/** Splits a server-sent event body into `{ event, data }` frames; comments are skipped. */
export async function* sseFrames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 1_000_000) throw new Error('Server event too large');
      let boundary = buffer.match(/\r?\n\r?\n/);
      while (boundary?.index !== undefined) {
        const lines = buffer.slice(0, boundary.index).split(/\r?\n/);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        const event = lines
          .find((line) => line.startsWith('event:'))
          ?.slice(6)
          .trim();
        if (data) yield { event: event ?? 'message', data };
        boundary = buffer.match(/\r?\n\r?\n/);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'x-hunkyard-csrf': '1',
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
