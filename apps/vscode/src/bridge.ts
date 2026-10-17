import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type ReviewSession, SessionSchema } from '@reviewlab/domain';

export const assertExtensionAccess = (trusted: boolean, scheme: string) => {
  if (!trusted || scheme !== 'file')
    throw new Error('ReviewLab requires a trusted local filesystem workspace.');
};
export const trustedExecutable = (
  configured: unknown,
  fallback: 'reviewlab' | 'node' = 'reviewlab',
) => {
  const executable = configured === undefined ? fallback : configured;
  if (
    typeof executable !== 'string' ||
    !executable.trim() ||
    executable.includes('\0') ||
    (executable !== fallback && !isAbsolute(executable))
  )
    throw new Error('Choose an absolute installed CLI executable in user settings.');
  return executable;
};
export const assertExternalExecutable = (root: string, executable: string) => {
  if (executable === 'reviewlab') return;
  const path = relative(resolve(root), resolve(executable));
  if (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
    throw new Error('CLI executable must be outside the reviewed workspace.');
};
export const resolveExecutable = async (root: string, executable: string): Promise<string> => {
  const canonicalRoot = await realpath(root);
  const choices = isAbsolute(executable)
    ? [executable]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .filter(isAbsolute)
        .map((path) => join(path, executable));
  for (const choice of choices) {
    try {
      const canonical = await realpath(choice);
      assertExternalExecutable(canonicalRoot, canonical);
      await access(canonical, canonical.endsWith('.mjs') ? constants.R_OK : constants.X_OK);
      return canonical;
    } catch {
      /* Try another installed executable; workspace paths are never executed. */
    }
  }
  throw new Error(
    'Installed CLI not found outside the workspace. Configure its absolute path in user settings.',
  );
};
export const runCli = (
  executable: string,
  root: string,
  args: string[],
  signal?: AbortSignal,
  nodeExecutable = 'node',
): Promise<unknown> =>
  resolveExecutable(root, executable).then(async (installed) => {
    const script = installed.endsWith('.mjs');
    const command = script ? await resolveExecutable(root, nodeExecutable) : installed;
    const commandArgs = [...(script ? [installed] : []), ...args, '--repo', root, '--json'];
    return new Promise((resolveResult, reject) => {
      execFile(
        command,
        commandArgs,
        {
          cwd: root,
          shell: false,
          ...(signal ? { signal } : {}),
          timeout: 600000,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout) => {
          if (error) {
            reject(
              new Error(
                'ReviewLab command failed or timed out. Check the CLI in a terminal; no changes were applied.',
              ),
            );
            return;
          }
          try {
            resolveResult(JSON.parse(stdout) as unknown);
          } catch {
            reject(new Error('ReviewLab CLI returned invalid JSON.'));
          }
        },
      );
    });
  });
export const frozenFindingSource = (session: ReviewSession, findingId: string) => {
  const parsed = SessionSchema.parse(session);
  const finding = parsed.findings.find((entry) => entry.id === findingId);
  if (!finding) throw new Error('Finding not found in the retained run.');
  const change = parsed.snapshot.changes.find(
    (entry) => (finding.side === 'old' ? entry.oldPath : entry.newPath) === finding.file,
  );
  const oid = finding.side === 'old' ? change?.oldOid : change?.newOid;
  const source = parsed.snapshot.sources.find((entry) => entry.oid === oid)?.text;
  return {
    text: source ?? parsed.snapshot.diff,
    line: source ? finding.line : 1,
    path: finding.file,
  };
};
