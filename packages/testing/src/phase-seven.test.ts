import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginReviewer, type ReviewAgent } from '@reviewlab/agents';
import { loadTarget, migrateUserConfig, updateConfig } from '@reviewlab/context';
import { createReviewService } from '@reviewlab/core';
import { ModelTargetSchema, PluginManifestSchema } from '@reviewlab/domain';
import { captureStaged } from '@reviewlab/git';
import { createRuntime } from '@reviewlab/server/runtime';
import { backupHistory, createSqliteSessionStore, restoreHistory } from '@reviewlab/storage';
import { expect, test, vi } from 'vitest';
import { createGitFixture } from './git-fixture';
import { fixtureSnapshot } from './replay';

const manifest = {
  apiVersion: 1,
  id: 'resource-lifetime',
  version: '1.0.0',
  description: 'Find resource leaks.',
  permissions: ['snapshot:read'],
  instructions: 'Find leaks in changed lines.',
};
test('plugin policy fails closed on capabilities and removes related source without losing admission limits', async () => {
  expect(() =>
    PluginManifestSchema.parse({ ...manifest, permissions: ['network:fetch'] }),
  ).toThrow();
  expect(() => PluginManifestSchema.parse({ ...manifest, apiVersion: 2 })).toThrow();
  expect(() => PluginManifestSchema.parse({ ...manifest, command: 'arbitrary shell' })).toThrow();
  expect(() => createPluginReviewer(manifest, [], { review: async () => [] })).toThrow(/requires/);
  const snapshot = fixtureSnapshot('');
  let received: Parameters<ReviewAgent['review']>[0] | undefined;
  const reviewer = createPluginReviewer(manifest, ['snapshot:read'], {
    review: async (input) => {
      received = input;
      return [];
    },
  });
  const context = {
    id: 'context',
    createdAt: new Date().toISOString(),
    snapshotId: snapshot.id,
    policyHash: 'policy',
    promptVersion: 'correctness-v1' as const,
    files: snapshot.files,
    excludedFiles: [],
    redacted: true as const,
    maxInputTokens: 1000,
    entries: [
      {
        hash: 'hash',
        path: 'secret.ts',
        startLine: 1,
        endLine: 1,
        oid: snapshot.indexTree,
        text: 'private related source',
        reason: 'import' as const,
      },
    ],
  };
  await reviewer.review({
    snapshot,
    context,
    instructions: [],
    target: ModelTargetSchema.parse({ repository: 'fixture', cloudConsent: false }),
    exclusions: [],
    signal: new AbortController().signal,
  });
  expect(received?.context?.entries).toEqual([]);
  expect(received?.context?.files).toEqual(snapshot.files);
  expect(received?.instructions.join(' ')).toContain('resource-lifetime@1.0.0');
  expect(context.entries).toHaveLength(1);
});

test('config migrations preserve explicit consent, refuse unknown versions and never infer source consent', () => {
  const input = { cloudConsent: { repo: true } };
  const migration = migrateUserConfig(input);
  expect(migration).toMatchObject({ fromVersion: 0, toVersion: 1, changed: true });
  expect(migration.config.cloudConsent.repo).toBe(true);
  expect(migration.config.contextCloudConsent).toEqual({});
  expect(input).toEqual({ cloudConsent: { repo: true } });
  expect(migrateUserConfig(migration.config).changed).toBe(false);
  expect(() => migrateUserConfig({ version: 2 })).toThrow(/Unsupported/);
  expect(() => migrateUserConfig({ version: 1, telemetry: true })).toThrow();
});

test('consistent backup restores immutable runs and interactions; refuses overwrite, corrupt input and wrong repository', async () => {
  const fixture = await createGitFixture();
  const temporary = await mkdtemp(join(tmpdir(), 'reviewlab-recovery-'));
  try {
    await writeFile(join(fixture.root, 'example.ts'), 'export const value = 2;\n');
    await fixture.git('add', 'example.ts');
    const snapshot = await captureStaged(fixture.root);
    const root = snapshot.repoRoot;
    const store = createSqliteSessionStore(root);
    const bundle = {
      plugin: PluginManifestSchema.parse(manifest),
      version: 1 as const,
      instructions: [],
      sources: [],
      exclusions: [],
    };
    const policy = {
      ...bundle,
      hash: createHash('sha256').update(JSON.stringify(bundle)).digest('hex'),
    };
    let pluginEnabled = true;
    const service = createReviewService({
      root,
      store,
      captureStaged: async () => snapshot,
      resolvePolicy: async () => {
        if (pluginEnabled) return policy;
        const { plugin: _plugin, ...plain } = bundle;
        return { ...plain, hash: createHash('sha256').update(JSON.stringify(plain)).digest('hex') };
      },
      loadTarget: async () => ModelTargetSchema.parse({ repository: root, cloudConsent: false }),
      agent: {
        review: async (input) => {
          expect(input.plugin).toEqual(bundle.plugin);
          return [];
        },
      },
    });
    const session = await service.start();
    await service.execute(session.id);
    const interaction = await store.interaction(session.id);
    await store.saveInteraction({ ...interaction, revision: 1 }, 0);
    const completed = await store.get(session.id);
    expect(completed?.status).toBe('completed');
    pluginEnabled = false;
    const rerun = await service.rerun(session.id, completed?.revision ?? -1);
    expect(rerun?.policy.plugin).toEqual(bundle.plugin);
    await service.execute(session.id);
    const expected = await store.get(session.id);
    expect(expected?.status).toBe('completed');
    pluginEnabled = true;
    const pending = await service.start();
    const backup = join(temporary, 'backup.db');
    const lease = await store.acquireRuntime();
    await backupHistory(root, backup);
    await lease.release();
    await expect(backupHistory(root, backup)).rejects.toThrow();
    await expect(restoreHistory(root, backup)).rejects.toThrow(/absent/);
    const other = await createGitFixture();
    try {
      await expect(restoreHistory(other.root, backup)).rejects.toThrow(/another repository/);
    } finally {
      await other.dispose();
    }
    await rename(join(root, '.reviewlab/sqlite'), join(root, '.reviewlab/preserved'));
    const corrupt = join(temporary, 'corrupt.db');
    await writeFile(corrupt, 'not sqlite');
    await expect(restoreHistory(root, corrupt)).rejects.toThrow();
    expect(await restoreHistory(root, backup)).toMatchObject({ restored: 2, interrupted: 1 });
    const restored = createSqliteSessionStore(root);
    expect(await restored.get(session.id)).toEqual(expected);
    expect((await restored.get(pending.id))?.status).toBe('cancelled');
    expect(await restored.interaction(session.id)).toEqual({ ...interaction, revision: 1 });
    expect(await restored.runs(session.id)).toHaveLength(2);
    expect(await readFile(join(root, 'example.ts'), 'utf8')).toBe('export const value = 2;\n');
  } finally {
    await fixture.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('runtime freezes a granted manifest and config writes preserve the unversioned original without expanding consent', async () => {
  const fixture = await createGitFixture();
  const directory = await mkdtemp(join(tmpdir(), 'reviewlab-config-migration-'));
  const config = join(directory, 'config.json');
  const original = JSON.stringify({ rules: ['Keep public APIs typed.'], cloudConsent: {} });
  vi.stubEnv('REVIEWLAB_USER_CONFIG', config);
  try {
    await writeFile(config, original);
    await loadTarget(fixture.root);
    expect(await readFile(config, 'utf8')).toBe(original);
    await updateConfig(fixture.root, { rules: ['Keep public APIs typed.'] });
    expect(await readFile(`${config}.v0.bak`, 'utf8')).toBe(original);
    expect(JSON.parse(await readFile(config, 'utf8'))).toMatchObject({
      version: 1,
      contextCloudConsent: {},
    });
    await writeFile(join(fixture.root, 'example.ts'), 'export const value = 2;\n');
    await fixture.git('add', 'example.ts');
    const plugin = PluginManifestSchema.parse(manifest);
    await expect(
      createRuntime(fixture.root, { plugin: { manifest: plugin, grants: [] } }),
    ).rejects.toThrow(/requires/);
    const runtime = await createRuntime(fixture.root, {
      plugin: { manifest: plugin, grants: ['snapshot:read'] },
    });
    try {
      const session = await runtime.service.start();
      expect((await runtime.store.get(session.id))?.policy.plugin).toEqual(plugin);
      expect(
        session.policy.sources.some((source) => source.path === 'plugin://resource-lifetime@1.0.0'),
      ).toBe(true);
    } finally {
      await runtime.close();
    }
    await writeFile(config, '{"version":99}');
    await expect(updateConfig(fixture.root, { rules: [] })).rejects.toThrow(/Unsupported/);
    expect(await readFile(config, 'utf8')).toBe('{"version":99}');
  } finally {
    vi.unstubAllEnvs();
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
