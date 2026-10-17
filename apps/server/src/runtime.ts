import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import {
  createConversationResponder,
  createCorrectnessReviewer,
  createLocalEmbedder,
  probeModel,
  probeModelCapabilities,
} from '@reviewlab/agents';
import {
  loadAuthorizedProviderSecret,
  loadReviewOptions,
  loadTarget,
  resolvePolicy,
  saveProviderSecret,
  scopedInstructions,
  updateConfig,
  withSharedPolicy,
} from '@reviewlab/context';
import { createReviewService } from '@reviewlab/core';
import type { ReviewServiceDependencies } from '@reviewlab/core/ports';
import {
  type PluginManifest,
  PluginManifestSchema,
  type PluginPermission,
  ReviewOptionsSchema,
  type ShareablePolicy,
  ShareablePolicySchema,
} from '@reviewlab/domain';
import {
  capturePullRequest,
  captureSnapshot,
  captureStaged,
  createPatchAdapter,
  getRepoRoot,
  githubRepository,
} from '@reviewlab/git';
import { createGitHubProvider, ghTransport } from '@reviewlab/providers';
import { createSqliteSessionStore } from '@reviewlab/storage';
import { createApi, problem } from './app';
import { buildFrozenContext, withSessionRules } from './context';

type RuntimeOptions = {
  writer?: boolean;
  sharedPolicy?: { policy: ShareablePolicy; granted: boolean };
  semantic?: Parameters<typeof createLocalEmbedder>[0];
  github?: ReviewServiceDependencies['github'];
  plugin?: { manifest: PluginManifest; grants: PluginPermission[] };
};
export const createRuntime = async (cwd: string, options: RuntimeOptions = {}) => {
  if (options.sharedPolicy) {
    if (options.sharedPolicy.granted !== true)
      throw new Error('Shared policy requires explicit per-run permission.');
    options.sharedPolicy.policy = ShareablePolicySchema.parse(options.sharedPolicy.policy);
  }
  const semantic = options.semantic ? createLocalEmbedder(options.semantic) : undefined;
  if (options.plugin) {
    PluginManifestSchema.parse(options.plugin.manifest);
    for (const permission of options.plugin.manifest.permissions)
      if (!options.plugin.grants.includes(permission))
        throw new Error(`Plugin requires ${permission}.`);
  }
  const root = await getRepoRoot(cwd);
  const store = createSqliteSessionStore(root);
  await store.assertHistoryMigrated();
  const writer = options.writer !== false;
  const lease = writer ? await store.acquireRuntime() : undefined;
  let recovered = 0;
  try {
    if (writer) recovered = await store.recover();
  } catch (error) {
    await lease?.release();
    throw error;
  }
  const resolveSecret = (target: Awaited<ReturnType<typeof loadTarget>>) =>
    loadAuthorizedProviderSecret(root, target);
  const authorizeGitHub = async () => {
    if ((await loadTarget(root)).privacy === 'local-only')
      throw new Error('GitHub access was revoked by local-only mode.');
  };
  const github = createGitHubProvider(async (method, path, body) => {
    await authorizeGitHub();
    return ghTransport(method, path, body);
  });
  const reviewer = createCorrectnessReviewer(undefined, resolveSecret);
  const service = createReviewService({
    github: options.github ?? {
      repository: () => githubRepository(root),
      capture: async (request, exclusions) =>
        capturePullRequest(
          root,
          await github.read(request),
          exclusions,
          undefined,
          authorizeGitHub,
        ),
      head: github.head,
      findPublication: github.findPublication,
      publish: github.publish,
    },
    root,
    captureStaged,
    capture: captureSnapshot,
    prepareInstructions: scopedInstructions,
    buildContext: (snapshot, policy, target, previous) =>
      buildFrozenContext(snapshot, policy, target, previous, semantic),
    resolvePolicy: async (root, files) => {
      const base = await resolvePolicy(root, files);
      const policy = options.sharedPolicy
        ? withSharedPolicy(base, options.sharedPolicy.policy)
        : base;
      if (!options.plugin) return policy;
      const { hash: _hash, ...data } = policy;
      const manifest = options.plugin.manifest;
      const content = JSON.stringify(manifest);
      const bundle = {
        plugin: manifest,
        ...data,
        sources: [
          ...data.sources,
          {
            path: `plugin://${manifest.id}@${manifest.version}`,
            hash: createHash('sha256').update(content).digest('hex'),
            truncated: false,
            format: 'plugin-api-v1',
            content,
          },
        ],
      };
      return { ...bundle, hash: createHash('sha256').update(JSON.stringify(bundle)).digest('hex') };
    },
    loadTarget,
    loadReviewOptions: async (root) => {
      const defaults = await loadReviewOptions(root);
      return options.sharedPolicy
        ? ReviewOptionsSchema.parse({ ...defaults, ...options.sharedPolicy.policy.review })
        : defaults;
    },
    agent: reviewer,
    store,
    applySessionRules: withSessionRules,
    patch: createPatchAdapter(root),
    respond: createConversationResponder(() => loadTarget(root), resolveSecret),
    writable: writer,
  });
  let closed = false;
  return {
    root,
    service,
    recovered,
    store,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await service.shutdown();
      } finally {
        await lease?.release();
      }
    },
  };
};
export const startServer = async (cwd: string, port = 4317, options: RuntimeOptions = {}) => {
  const runtime = await createRuntime(cwd, options);
  const { root, service } = runtime;
  const token = randomBytes(32).toString('hex');
  const origin = `http://127.0.0.1:${port}`;
  const app = createApi({
    service,
    token,
    origin,
    workspaceName: basename(root),
    target: () => loadTarget(root),
    configure: (model, allowCloud) =>
      updateConfig(root, { model, ...(allowCloud !== undefined ? { allowCloud } : {}) }),
    probe: async () =>
      probeModel(await loadTarget(root), undefined, undefined, (target) =>
        loadAuthorizedProviderSecret(root, target),
      ),
    probeCapabilities: async () =>
      probeModelCapabilities(await loadTarget(root), undefined, undefined, (target) =>
        loadAuthorizedProviderSecret(root, target),
      ),
    secret: (provider, secret) => saveProviderSecret(root, provider, secret),
  });
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) return problem(c, 404, 'API route not found');
    const requested = c.req.path === '/' ? 'index.html' : c.req.path.slice(1);
    if (!/^(?:index\.html|assets\/[a-zA-Z0-9_.-]+)$/.test(requested))
      return c.text('Not found', 404);
    try {
      const sourceAssets = new URL(`../../web/dist/${requested}`, import.meta.url);
      const bundledAssets = new URL(`./web/${requested}`, import.meta.url);
      const bytes = await readFile(fileURLToPath(bundledAssets)).catch(() =>
        readFile(fileURLToPath(sourceAssets)),
      );
      const type = requested.endsWith('.js')
        ? 'application/javascript'
        : requested.endsWith('.css')
          ? 'text/css'
          : requested.endsWith('.ttf')
            ? 'font/ttf'
            : 'text/html';
      c.header('Content-Type', type);
      c.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'; font-src 'self' data:; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      return c.body(bytes);
    } catch {
      return c.text('Web build missing. Run pnpm build before reviewlab open.', 503);
    }
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }
  return {
    token,
    origin,
    root,
    service,
    close: async () => {
      await runtime.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        if ('closeAllConnections' in server) server.closeAllConnections();
      });
    },
  };
};
