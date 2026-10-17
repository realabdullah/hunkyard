import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, relative } from 'node:path';
import { fixtureStatePath } from './runtime-path';
export default async () => {
  try {
    const record = JSON.parse(await readFile(fixtureStatePath, 'utf8')) as {
      root: string;
      configFile: string;
    };
    const config = dirname(record.configFile);
    // The descriptor can authorize removal only of this suite's disposable top-level temp directories.
    if (
      dirname(relative(tmpdir(), record.root)) !== '.' ||
      !basename(record.root).startsWith('hunkyard-test-') ||
      dirname(relative(tmpdir(), config)) !== '.' ||
      !basename(config).startsWith('hunkyard-e2e-config-')
    )
      throw new Error('Invalid disposable fixture cleanup paths.');
    await rm(record.root, { recursive: true, force: true });
    await rm(config, { recursive: true, force: true });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  } finally {
    await rm(fixtureStatePath, { force: true });
  }
};
