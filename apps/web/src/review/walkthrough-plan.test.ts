import type { ReviewSnapshot, SnapshotFileChange } from '@hunkyard/domain';
import { expect, test } from 'vitest';
import { buildHandoff, readingPath } from './walkthrough-plan';

const files: Record<string, string> = {
  'src/ui/App.tsx': "import { total } from '../cart.js';\nexport const App = () => total;\n",
  'src/cart.ts': "import type { Item } from './types';\nexport const total = 1;\n",
  'src/types.ts': 'export type Item = { price: number };\n',
  'src/cart.test.ts': "import { total } from './cart';\n",
  'README.md': '# Shop\n',
  'pnpm-lock.yaml': 'lockfileVersion: 9\n',
  'package.json': '{}\n',
};
const oidOf = (index: number) => String(index + 1).padStart(40, '0');
const snapshot = {
  diff: Object.entries(files)
    .map(([path, text]) => {
      const lines = text.trimEnd().split('\n');
      return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
    })
    .join(''),
  changes: Object.keys(files).map(
    (path, index): SnapshotFileChange => ({
      status: 'A',
      oldPath: null,
      newPath: path,
      oldMode: null,
      newMode: '100644',
      oldOid: null,
      newOid: oidOf(index),
      binary: false,
    }),
  ),
  sources: Object.values(files).map((text, index) => ({ oid: oidOf(index), bytes: '', text })),
} as unknown as ReviewSnapshot;

test('reading path puts definitions before their users, then tests, config, docs and generated', () => {
  const path = readingPath(snapshot);
  expect(path.map((stop) => stop.path)).toEqual([
    'src/types.ts',
    'src/cart.ts',
    'src/ui/App.tsx',
    'src/cart.test.ts',
    'package.json',
    'README.md',
    'pnpm-lock.yaml',
  ]);
  const cart = path.find((stop) => stop.path === 'src/cart.ts');
  expect(cart).toMatchObject({
    uses: ['src/types.ts'],
    usedBy: ['src/cart.test.ts', 'src/ui/App.tsx'],
    added: 2,
  });
});

test('handoff lists notes by file in reading order with the line they point at', () => {
  const note = (path: string, line: number | null, text: string) => ({
    id: crypto.randomUUID(),
    snapshotId: crypto.randomUUID(),
    path,
    side: 'new' as const,
    line,
    text,
    createdAt: new Date().toISOString(),
  });
  const path = readingPath(snapshot);
  const text = buildHandoff(
    snapshot,
    path,
    [note('src/ui/App.tsx', 2, 'Render a component'), note('src/cart.ts', 2, 'Sum the items')],
    'request-changes',
    'Close, two things.',
  );
  expect(text.indexOf('## src/cart.ts')).toBeLessThan(text.indexOf('## src/ui/App.tsx'));
  expect(text).toContain('- Line 2 `export const total = 1;`: Sum the items');
  expect(text).toContain('Close, two things.');
  expect(buildHandoff(snapshot, path, [], 'approve', '')).toBe(
    'I reviewed your changes (7 files) and approve them.',
  );
});
