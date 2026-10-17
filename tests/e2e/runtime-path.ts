import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const fixtureStatePath = join(
  tmpdir(),
  `hunkyard-e2e-${createHash('sha256').update(process.cwd()).digest('hex')}.json`,
);
