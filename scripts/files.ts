import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const excluded = new Set([
  'node_modules',
  '.git',
  'dist',
  '.hunkyard',
  'test-results',
  'playwright-report',
]);
export const listFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
};
