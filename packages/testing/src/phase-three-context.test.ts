import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCorrectnessReviewer } from '@reviewlab/agents';
import { collectContext, loadTarget, resolvePolicy, scopedInstructions } from '@reviewlab/context';
import { createReviewService } from '@reviewlab/core';
import { matchesPath } from '@reviewlab/domain';
import { captureSnapshot, runBytes, treeEntries } from '@reviewlab/git';
import { createSqliteSessionStore } from '@reviewlab/storage';
import { expect, test } from 'vitest';
import { createGitFixture } from './git-fixture';

const setup = async (
  run: (fixture: Awaited<ReturnType<typeof createGitFixture>>) => Promise<void>,
) => {
  const fixture = await createGitFixture();
  const directory = await mkdtemp(join(tmpdir(), 'reviewlab-context-test-'));
  const previous = process.env.REVIEWLAB_USER_CONFIG;
  process.env.REVIEWLAB_USER_CONFIG = join(directory, 'config.json');
  try {
    await run(fixture);
  } finally {
    if (previous === undefined) delete process.env.REVIEWLAB_USER_CONFIG;
    else process.env.REVIEWLAB_USER_CONFIG = previous;
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
};
const reader = async (root: string, tree: string) => ({
  entries: await treeEntries(root, tree),
  read: async (oid: string) => (await runBytes(root, ['cat-file', 'blob', oid])).toString(),
});

test('nested adapters, Cursor globs, narrow Qodo TOML, explicit precedence and global policy are deterministic', async () =>
  setup(async ({ root }) => {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, '.cursor/rules'), { recursive: true });
    await mkdir(join(root, '.github'));
    await mkdir(join(root, '.reviewlab'));
    await writeFile(join(root, 'AGENTS.md'), 'Root rule');
    await writeFile(join(root, 'src/AGENTS.md'), 'Nested rule');
    await writeFile(join(root, 'CLAUDE.md'), 'Claude rule');
    await writeFile(join(root, '.github/copilot-instructions.md'), 'Copilot rule');
    await writeFile(
      join(root, '.cursor/rules/frontend.mdc'),
      '---\nglobs: ["src/**/*.tsx"]\nalwaysApply: false\n---\nFrontend rule',
    );
    await writeFile(
      join(root, '.cursor/rules/manual.mdc'),
      '---\ndescription: Manual only\nalwaysApply: false\n---\nManual rule',
    );
    await writeFile(
      join(root, '.pr_agent.toml'),
      '[pr_reviewer]\nextra_instructions = "Qodo advisory"\n[config]\nmodel = "not-authority"\n',
    );
    const paths = ['src/Page.tsx', 'example.ts'];
    const first = await resolvePolicy(root, paths);
    expect(await resolvePolicy(root, paths)).toEqual(first);
    const refs = first.fileRules?.find((rule) => rule.path === 'src/Page.tsx')?.sourcePaths ?? [];
    expect(refs).toContain('src/AGENTS.md');
    expect(refs).toContain('.cursor/rules/frontend.mdc');
    expect(first.fileRules?.find((rule) => rule.path === 'example.ts')?.sourcePaths).not.toContain(
      'src/AGENTS.md',
    );
    expect(first.sources.find((source) => source.path === '.pr_agent.toml')?.content).toBe(
      'Qodo advisory',
    );
    expect(first.diagnostics?.join(' ')).toContain('manual');
    expect(first.conflicts?.[0]?.resolution).toContain('owner inspection');
    await writeFile(
      join(root, '.reviewlab/config.json'),
      JSON.stringify({ instructionOrder: ['src/AGENTS.md', 'AGENTS.md'] }),
    );
    const ordered = await resolvePolicy(root, paths);
    expect(
      ordered.fileRules?.find((rule) => rule.path === 'src/Page.tsx')?.sourcePaths.slice(-2),
    ).toEqual(['src/AGENTS.md', 'AGENTS.md']);
    expect(ordered.hash).not.toBe(first.hash);
    await writeFile(
      join(root, '.reviewlab/config.json'),
      JSON.stringify({ instructionSources: ['agents'] }),
    );
    expect((await resolvePolicy(root, paths)).sources.map((source) => source.path)).toEqual([
      'AGENTS.md',
      'src/AGENTS.md',
    ]);
  }));

test('instruction symlink escapes and oversized rules fail before policy can be used', async () =>
  setup(async ({ root }) => {
    await symlink('/etc/passwd', join(root, 'AGENTS.md'));
    await expect(resolvePolicy(root)).rejects.toThrow('Unsafe');
    await rm(join(root, 'AGENTS.md'));
    await writeFile(join(root, 'AGENTS.md'), 'x'.repeat(1_000_001));
    await expect(resolvePolicy(root)).rejects.toThrow('oversized');
  }));

test('frozen surrounding/import/test/symbol context is bounded, redacted, hash-proven and excludes vendor source', async () =>
  setup(async ({ root, git }) => {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'vendor'));
    await writeFile(
      join(root, 'src/helper.ts'),
      'export const helper = () => 1;\nconst password = "keep-private";\n',
    );
    await writeFile(
      join(root, 'src/example.test.ts'),
      'import { calculate } from "./example";\nexpect(calculate()).toBe(1);\n',
    );
    await writeFile(
      join(root, 'src/references.ts'),
      'import { calculate } from "./example";\ncalculate();\n',
    );
    await writeFile(join(root, 'vendor/hidden.ts'), 'const calculate = "excluded";\n');
    await writeFile(join(root, 'src/example.ts'), 'export const calculate = () => 1;\n');
    await git('add', '.');
    await git('commit', '-m', 'test: navigation baseline');
    await writeFile(
      join(root, 'src/example.ts'),
      'import { helper } from "./helper";\nexport const calculate = () => helper() + 1;\n',
    );
    await git('add', '.');
    const snapshot = await captureSnapshot(root);
    const policy = await resolvePolicy(root, snapshot.files);
    policy.exclusions.push('vendor/**');
    const target = await loadTarget(root);
    const context = await collectContext(
      snapshot,
      policy,
      target,
      await reader(root, snapshot.indexTree),
      24000,
    );
    expect(context.entries?.map((entry) => [entry.path, entry.reason])).toEqual(
      expect.arrayContaining([
        ['src/example.ts', 'surrounding'],
        ['src/helper.ts', 'import'],
        ['src/example.test.ts', 'test'],
        ['src/references.ts', 'reference'],
      ]),
    );
    expect(context.entries?.some((entry) => entry.path.startsWith('vendor/'))).toBe(false);
    expect(context.entries?.find((entry) => entry.path === 'src/helper.ts')?.text).toContain(
      '[REDACTED]',
    );
    for (const entry of context.entries ?? [])
      expect(entry.hash).toBe(createHash('sha256').update(entry.text).digest('hex'));
    await writeFile(join(root, 'src/helper.ts'), 'live replacement');
    expect(context.entries?.find((entry) => entry.path === 'src/helper.ts')?.text).toContain(
      'helper = () => 1',
    );
    const tiny = await collectContext(
      snapshot,
      policy,
      { ...target, contextWindow: 1024, maxTokens: 512 },
      await reader(root, snapshot.indexTree),
      1024,
    );
    expect(tiny.files).toEqual([]);
    expect(tiny.omissions?.some((entry) => entry.reason.includes('Reviewer input budget'))).toBe(
      true,
    );
  }));

test('runtime contracts persist omission/context/rule provenance; reviewer cannot anchor findings in omitted sources', async () =>
  setup(async ({ root, git }) => {
    await writeFile(join(root, 'example.ts'), 'export const value = 2;\n');
    await git('add', '.');
    const store = createSqliteSessionStore(root);
    const service = createReviewService({
      root,
      store,
      captureStaged: async () => captureSnapshot(root),
      capture: captureSnapshot,
      resolvePolicy,
      loadTarget,
      prepareInstructions: scopedInstructions,
      buildContext: async (snapshot, policy, target) =>
        collectContext(snapshot, policy, target, await reader(root, snapshot.indexTree)),
      agent: {
        review: async ({ context }) => {
          expect(context?.entries?.[0]?.text).toContain('value = 2');
          return [];
        },
      },
    });
    const session = await service.start({ kind: 'working-tree' });
    await service.execute(session.id);
    const saved = await createSqliteSessionStore(root).get(session.id);
    expect(saved?.status).toBe('completed');
    expect(saved?.context?.entries).toEqual(session.context?.entries);
    const policy = await resolvePolicy(root, session.snapshot.files);
    const target = await loadTarget(root);
    const context = await collectContext(
      session.snapshot,
      policy,
      { ...target, contextWindow: 1024 },
      await reader(root, session.snapshot.indexTree),
    );
    let requests = 0;
    const reviewer = createCorrectnessReviewer(async () => {
      requests += 1;
      throw new Error('No request expected');
    });
    expect(
      await reviewer.review({
        snapshot: session.snapshot,
        instructions: [],
        target,
        exclusions: [],
        signal: new AbortController().signal,
        context,
      }),
    ).toEqual([]);
    expect(requests).toBe(0);
    await service.shutdown();
  }));

test('portable root-relative globs distinguish directories and support nested matches without regex injection', () => {
  expect(matchesPath('src/Page.tsx', 'src/**/*.tsx')).toBe(true);
  expect(matchesPath('src/a/Page.tsx', 'src/**/*.tsx')).toBe(true);
  expect(matchesPath('src/a/Page.tsx', 'src/*.tsx')).toBe(false);
  expect(matchesPath('vendor/a.ts', 'vendor/')).toBe(true);
  expect(matchesPath('a[1].ts', 'a[1].ts')).toBe(true);
});

test('pruned Git navigation falls back visibly to retained sources when a saved snapshot is rerun', async () =>
  setup(async ({ root, git }) => {
    const { buildFrozenContext } = await import('@reviewlab/server/context');
    await writeFile(join(root, 'example.ts'), 'export const saved = 2;\n');
    await git('add', '.');
    const snapshot = await captureSnapshot(root);
    const policy = await resolvePolicy(root, snapshot.files);
    const target = await loadTarget(root);
    const original = await buildFrozenContext(snapshot, policy, target);
    await git('reset', '--mixed', 'HEAD');
    await git('prune', '--expire=now');
    const rebuilt = await buildFrozenContext(snapshot, policy, target, original);
    expect(rebuilt.files).toEqual(['example.ts']);
    expect(rebuilt.entries?.[0]?.text).toContain('saved = 2');
    expect(
      rebuilt.omissions?.some((entry) => entry.reason.includes('navigation tree unavailable')),
    ).toBe(true);
  }));

test('staged-only cloud consent cannot authorize Phase3 related source; explicit renewed consent is required', async () =>
  setup(async ({ root }) => {
    const { configPath, repositoryKey, updateConfig } = await import('@reviewlab/context');
    await writeFile(
      configPath(),
      JSON.stringify({
        version: 1,
        model: {
          provider: 'openai',
          endpoint: 'https://api.openai.com',
          model: 'fixture',
          privacy: 'cloud-allowed',
        },
        cloudConsent: { [repositoryKey(root)]: true },
      }),
    );
    expect((await loadTarget(root)).cloudConsent).toBe(false);
    const renewed = await updateConfig(root, { allowCloud: true });
    expect(renewed.cloudConsent).toBe(true);
    expect((await updateConfig(root, { allowCloud: false })).cloudConsent).toBe(false);
  }));
