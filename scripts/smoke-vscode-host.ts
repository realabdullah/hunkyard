import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'hunkyard-vscode-host-'));
try {
  const result = await execute(
    process.env.HUNKYARD_VSCODE_EXECUTABLE ?? 'code',
    [
      '--new-window',
      '--disable-workspace-trust',
      '--disable-updates',
      '--skip-welcome',
      '--skip-release-notes',
      '--user-data-dir',
      join(directory, 'user'),
      '--extensions-dir',
      join(directory, 'extensions'),
      `--extensionDevelopmentPath=${resolve('dist/vscode/extension')}`,
      `--extensionTestsPath=${resolve('scripts/vscode-host-test.cjs')}`,
      directory,
    ],
    { timeout: 60000, maxBuffer: 1024 * 1024 },
  );
  console.log(result.stdout);
  console.log(
    'Isolated VS Code extension-host activation, commands and virtual-source provider passed. No model inference performed.',
  );
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
