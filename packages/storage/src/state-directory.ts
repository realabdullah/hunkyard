import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { LEGACY_STATE_DIRECTORY, STATE_DIRECTORY } from '@hunkyard/domain';

const absent = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/**
 * Returns the state folder that holds `entry` for a repository: `.hunkyard` when it has the
 * entry, otherwise a pre-rename `.reviewlab` that has it, otherwise `.hunkyard` for new data.
 * Legacy data is read in place; it is never moved or deleted.
 */
export const stateDirectory = async (root: string, entry: string): Promise<string> => {
  for (const name of [STATE_DIRECTORY, LEGACY_STATE_DIRECTORY]) {
    try {
      await lstat(join(root, name, entry));
      return join(root, name);
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }
  return join(root, STATE_DIRECTORY);
};

export const historyDatabasePath = async (root: string) =>
  join(await stateDirectory(root, 'sqlite'), 'sqlite', 'history.db');
