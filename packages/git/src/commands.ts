import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { Readable } from 'node:stream';

export type GitRunner = (cwd: string, ...args: string[]) => Promise<string>;
export const runBytes = (
  cwd: string,
  args: string[],
  options: { index?: string; input?: Buffer | Readable; maxBuffer?: number } = {},
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
        timeout: 15_000,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
          ),
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_LAZY_FETCH: '1',
          ...(options.index ? { GIT_INDEX_FILE: options.index } : {}),
        },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.on('error', () => {});
    if (options.input instanceof Readable) {
      const stream = options.input;
      stream.on('error', (error) => {
        child.kill();
        reject(error);
      });
      child.on('close', () => stream.destroy());
      if (child.stdin) stream.pipe(child.stdin);
    } else child.stdin?.end(options.input);
  });
export const git: GitRunner = async (cwd, ...args) => (await runBytes(cwd, args)).toString('utf8');
export const readHead = async (run: GitRunner, root: string): Promise<string | null> => {
  try {
    return (await run(root, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}')).trim();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 1)) throw error;
    const ref = (await run(root, 'symbolic-ref', 'HEAD')).trim();
    try {
      await run(root, 'show-ref', '--verify', '--quiet', ref);
    } catch (refError) {
      if (refError instanceof Error && 'code' in refError && refError.code === 1) return null;
      throw refError;
    }
    throw error;
  }
};
/** Git prints `C:/...` on Windows; identity checks compare against the native real path. */
export const canonicalRoot = async (run: GitRunner, cwd: string): Promise<string> =>
  realpath((await run(cwd, 'rev-parse', '--show-toplevel')).replace(/\n$/, ''));
export const getRepoRoot = (cwd = process.cwd()): Promise<string> => canonicalRoot(git, cwd);
export const resolveCommit = async (root: string, ref: string): Promise<string> => {
  try {
    return (await git(root, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`)).trim();
  } catch {
    throw new Error(
      'Missing or invalid commit reference. Fetch/restore it explicitly before reviewing.',
    );
  }
};
export const treeEntries = async (root: string, tree: string) =>
  (await git(root, 'ls-tree', '-r', '-z', tree))
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const match = record.match(/^(\d{6}) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/);
      if (!match?.[1] || !match[3] || !match[4]) throw new Error('Malformed tree entry.');
      return { mode: match[1], oid: match[3], path: match[4] };
    });
