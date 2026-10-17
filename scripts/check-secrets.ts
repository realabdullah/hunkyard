import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { listFiles } from './files';
import { containsSecret } from './secrets';

const root = process.cwd();
let failures = 0;
for (const file of await listFiles(root)) {
  if (file.endsWith('pnpm-lock.yaml')) continue;
  if (containsSecret(await readFile(file, 'utf8'))) {
    console.error(`Possible secret in ${relative(root, file)} (value redacted).`);
    failures += 1;
  }
}
if (failures) process.exitCode = 1;
else console.log('Working-tree secret patterns checked.');
