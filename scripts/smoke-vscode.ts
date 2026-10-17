import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'reviewlab-vscode-smoke-'));
try {
  const flags = [
    '--user-data-dir',
    join(directory, 'user'),
    '--extensions-dir',
    join(directory, 'extensions'),
  ];
  const code = process.env.REVIEWLAB_VSCODE_EXECUTABLE ?? 'code';
  const installed = await execute(
    code,
    [...flags, '--install-extension', resolve('dist/reviewlab-vscode-0.1.1.vsix')],
    { timeout: 60000 },
  );
  if (!installed.stdout.includes('successfully installed'))
    throw new Error(`VSIX installation failed: ${installed.stdout}`);
  const listed = await execute(code, [...flags, '--list-extensions', '--show-versions'], {
    timeout: 60000,
  });
  if (!listed.stdout.includes('reviewlab.reviewlab-vscode@0.1.1'))
    throw new Error('Installed extension is missing from the isolated profile.');
  await execute(code, [...flags, '--uninstall-extension', 'reviewlab.reviewlab-vscode'], {
    timeout: 60000,
  });
  console.log(
    'VSIX install/list/uninstall passed in an isolated VS Code profile. Extension-host UI journeys require separate verification.',
  );
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
