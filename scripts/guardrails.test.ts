import { expect, test } from 'vitest';
import { assertAcyclic, importedModules } from './boundaries';
import { containsSecret } from './secrets';

test('boundary parser covers re-exports, dynamic and type imports', () => {
  expect(
    importedModules(
      `export { x } from '@hunkyard/git'; const x = import('node:fs'); type T = import('@hunkyard/storage').T;`,
      'fixture.ts',
    ),
  ).toEqual(['@hunkyard/git', 'node:fs', '@hunkyard/storage']);
  expect(() => importedModules('import(target)', 'fixture.ts')).toThrow('nonliteral');
  expect(() =>
    assertAcyclic(
      new Map([
        ['a', ['b']],
        ['b', ['a']],
      ]),
    ),
  ).toThrow('cycle');
});

test('secret patterns detect supported credentials without logging values', () => {
  expect(containsSecret(`key = 'sk-${'A'.repeat(40)}'`)).toBe(true);
  expect(containsSecret(['-----BEGIN', 'PRIVATE KEY-----'].join(' '))).toBe(true);
  expect(containsSecret('OPENAI_API_KEY=your-key')).toBe(false);
});
