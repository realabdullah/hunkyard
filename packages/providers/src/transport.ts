import { execFile } from 'node:child_process';

export type GitHubResponse = { status: number; headers: Record<string, string>; data: unknown };
export type GitHubTransport = (
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
) => Promise<GitHubResponse>;
export class GitHubError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfter?: string,
  ) {
    super(
      status === 401
        ? 'GitHub authentication required. Run gh auth login --hostname github.com.'
        : status === 403 || status === 429
          ? `GitHub permission or rate limit refused the request${retryAfter ? `; retry after ${retryAfter} seconds` : ''}.`
          : `GitHub request failed (HTTP ${status}); no automatic publication retry.`,
    );
  }
}
export const ghTransport: GitHubTransport = (method, path, body) =>
  new Promise((resolve, reject) => {
    if (!/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//.test(path)) {
      reject(new Error('Unsupported GitHub API destination.'));
      return;
    }
    const child = execFile(
      'gh',
      [
        'api',
        '--hostname',
        'github.com',
        '--include',
        '--method',
        method,
        '-H',
        'Accept: application/vnd.github+json',
        '-H',
        'X-GitHub-Api-Version: 2022-11-28',
        path,
        ...(body === undefined ? [] : ['--input', '-']),
      ],
      {
        timeout: 30000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          GH_HOST: 'github.com',
          GH_PROMPT_DISABLED: '1',
          GH_DEBUG: '',
          GH_PAGER: 'cat',
        },
      },
      (error, stdout) => {
        const match = stdout.match(/^HTTP\/[^ ]+ (\d+)[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
        if (!match) {
          reject(
            new Error(
              'GitHub CLI unavailable, unauthenticated, timed out or returned an invalid response. Run gh auth login --hostname github.com; no request was retried.',
            ),
          );
          return;
        }
        const status = Number(match[1]);
        const headers = Object.fromEntries(
          (match[2] ?? '').split(/\r?\n/).map((line) => {
            const colon = line.indexOf(':');
            return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
          }),
        );
        if (error && status < 400) {
          reject(new Error('GitHub response was interrupted.'));
          return;
        }
        try {
          resolve({ status, headers, data: JSON.parse(match[3] ?? '') });
        } catch {
          reject(new Error('GitHub returned invalid JSON.'));
        }
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(body === undefined ? undefined : JSON.stringify(body));
  });
export const createGitHubClient = (
  transport: GitHubTransport = ghTransport,
  wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
) => {
  const request = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await transport(method, path, body);
      if (response.status >= 200 && response.status < 300) return response.data;
      const retry = response.headers['retry-after'];
      const seconds = retry === undefined ? 1 : Number(retry);
      const limited =
        response.status === 429 ||
        (response.status === 403 &&
          (retry !== undefined || response.headers['x-ratelimit-remaining'] === '0'));
      if (
        method === 'GET' &&
        attempt === 0 &&
        (limited || response.status >= 500) &&
        Number.isFinite(seconds) &&
        seconds >= 0 &&
        seconds <= 2
      ) {
        await wait(Math.max(seconds * 1000, 100));
        continue;
      }
      throw new GitHubError(response.status, retry);
    }
  };
  const list = async (path: string): Promise<unknown[]> => {
    const result: unknown[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const data = await request(
        'GET',
        `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      );
      if (!Array.isArray(data)) throw new Error('GitHub returned an invalid paginated response.');
      result.push(...data);
      if (data.length < 100) return result;
    }
    throw new Error(
      'GitHub pagination budget exceeded (1000 entries); incomplete context refused.',
    );
  };
  return { request, list };
};
