import {
  type CaptureRequest,
  type ContextManifest,
  cancelAgentStates,
  excludedPath,
  isHostedProvider,
  type ReviewPolicyBundle,
  type ReviewSession,
  type ReviewSnapshot,
} from '@reviewlab/domain';
import { createReviewExecutor } from './execution';
import { createInteractionService } from './interaction';
import { createReviewPlan } from './orchestration';
import { captureGitHub, createPullRequestService } from './pull-request';
import { createReviewQueue } from './queue';

export { findingKey } from '@reviewlab/domain';
export { createReviewPlan } from './orchestration';

import type { ReviewServiceDependencies } from './ports';

export const createReviewService = (deps: ReviewServiceDependencies) => {
  const { store, root, captureStaged, resolvePolicy, loadTarget } = deps;
  let stopping = false;
  const controllers = new Map<string, AbortController>();
  const executionQueue = createReviewQueue();
  let queue: Promise<unknown> = Promise.resolve();
  const writable = () => {
    if (stopping) throw new Error('ReviewLab is shutting down.');
    if (deps.writable === false) throw new Error('This workspace connection is read-only.');
  };
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const save = async (session: ReviewSession) => {
    session.revision += 1;
    await store.save(session);
  };
  const assertIdle = async () => {
    writable();
    const target = await loadTarget(root);
    const active = (await store.list()).filter((session) =>
      ['queued', 'running'].includes(session.status),
    ).length;
    if (
      deps.loadReviewOptions
        ? active >= 32
        : Math.max(active, controllers.size) >= (target.maxConcurrency ?? 1)
    )
      throw new Error(
        deps.loadReviewOptions
          ? 'Review queue is full (32 active or queued sessions). Wait or cancel a review.'
          : 'A review is already active. Wait or cancel an interrupted review.',
      );
  };
  const input = async (
    snapshot?: ReviewSnapshot,
    request: unknown = {},
    previous?: ContextManifest,
    options?: unknown,
    rules: string[] = [],
    frozenPolicy?: ReviewPolicyBundle,
  ) => {
    const target = await loadTarget(root);
    if (
      isHostedProvider(target.provider) &&
      (target.privacy === 'local-only' || !target.cloudConsent)
    )
      throw new Error('Hosted review requires cloud-allowed mode and explicit repository consent.');
    const plan = deps.loadReviewOptions
      ? createReviewPlan(target, options ?? (await deps.loadReviewOptions(root)))
      : undefined;
    const contextTarget = plan
      ? {
          ...target,
          contextWindow: Math.min(
            ...plan.agents.map((route) => route.target.contextWindow ?? 128000),
          ),
          maxTokens: Math.max(...plan.agents.map((route) => route.target.maxTokens)),
          // Every reviewer sends the same context, so each first request must fit its share of
          // the shared run budget; larger contexts are trimmed here with recorded omissions.
          maxReviewTokens: Math.min(
            target.maxReviewTokens ?? 400000,
            Math.floor(plan.maxTokens / plan.agents.length),
          ),
        }
      : target;
    const initialPolicy = await resolvePolicy(root);
    const frozen =
      snapshot ??
      (deps.capture
        ? await deps.capture(root, request, initialPolicy.exclusions)
        : await captureStaged(root));
    const resolvedPolicy =
      frozenPolicy ??
      (await resolvePolicy(
        root,
        frozen.changes
          .flatMap((change) => [change.oldPath, change.newPath])
          .filter((path): path is string => path !== null),
      ));
    const policy =
      rules.length && deps.applySessionRules
        ? deps.applySessionRules(resolvedPolicy, rules)
        : resolvedPolicy;
    const excludedFiles = frozen.changes
      .filter(
        (change) =>
          excludedPath(change.oldPath, policy.exclusions) ||
          excludedPath(change.newPath, policy.exclusions),
      )
      .map((change) => change.newPath ?? change.oldPath)
      .filter((path): path is string => path !== null);
    return {
      runId: globalThis.crypto.randomUUID(),
      state: 'ready' as const,
      status: 'queued' as const,
      snapshot: frozen,
      target,
      ...(plan ? { plan } : {}),
      policy,
      findings: [],
      instructions: policy.instructions,
      context: deps.buildContext
        ? await deps.buildContext(frozen, policy, contextTarget, previous)
        : {
            id: globalThis.crypto.randomUUID(),
            snapshotId: frozen.id,
            policyHash: policy.hash,
            promptVersion: 'correctness-v1' as const,
            files: frozen.files.filter((file) => !excludedFiles.includes(file)),
            excludedFiles,
            redacted: true as const,
            maxInputTokens: Math.max(1, (target.contextWindow ?? 128000) - target.maxTokens),
            createdAt: new Date().toISOString(),
          },
    };
  };
  const executeInternal = createReviewExecutor({ ...deps, controllers, writable, serial, save });
  const interaction = createInteractionService(deps, writable);
  const execute = async (id: string) => {
    writable();
    const session = await store.get(id);
    if (!session || session.status !== 'queued') return;
    return executionQueue.add(
      id,
      session.plan?.options.priority ?? 'interactive',
      session.target.maxConcurrency ?? 1,
      async () => {
        await executeInternal(id);
        await interaction.reconcile(id);
      },
    );
  };
  return {
    interaction,
    github: createPullRequestService(deps, { writable, serial }),
    startPullRequest: (request: unknown, options?: unknown) =>
      serial(async (): Promise<ReviewSession> => {
        await assertIdle();
        const policy = await resolvePolicy(root);
        const snapshot = await captureGitHub(deps, request, policy.exclusions);
        const session: ReviewSession = {
          version: 2,
          revision: 0,
          id: globalThis.crypto.randomUUID(),
          ...(await input(snapshot, {}, undefined, options)),
          createdAt: new Date().toISOString(),
        };
        await store.save(session);
        return session;
      }),
    plan: async (options?: unknown) =>
      createReviewPlan(
        await loadTarget(root),
        options ?? (deps.loadReviewOptions ? await deps.loadReviewOptions(root) : {}),
      ),
    list: () => store.list(),
    get: (id: string) => store.get(id),
    runs: async (id: string) => (store.runs ? store.runs(id) : []),
    snapshots: async (id: string) => (store.snapshots ? store.snapshots(id) : []),
    events: async (id: string, after: number) => (store.events ? store.events(id, after) : []),
    usage: async () =>
      store.usage ? store.usage() : { sessions: 0, runs: 0, snapshots: 0, bytes: 0 },
    start: (request: unknown = {}, options?: unknown) =>
      serial(async (): Promise<ReviewSession> => {
        await assertIdle();
        const session: ReviewSession = {
          version: 2,
          revision: 0,
          id: globalThis.crypto.randomUUID(),
          ...(await input(undefined, request, undefined, options)),
          createdAt: new Date().toISOString(),
        };
        await store.save(session);
        return session;
      }),
    rerun: (
      id: string,
      revision: number,
      recapture = false,
      options?: unknown,
      paths?: string[],
      allowGitHub = false,
    ) =>
      serial(async () => {
        await assertIdle();
        if (controllers.has(id))
          throw new Error('The cancelled review is still stopping. Retry shortly.');
        if (!store.runs) throw new Error('Durable run storage is required to reopen a session.');
        const previous = await store.get(id);
        if (!previous) return null;
        if (previous.revision !== revision)
          throw new Error('Session revision conflict. Reload before changing it.');
        const pr = previous.snapshot.pullRequest;
        if (pr && recapture && paths?.length)
          throw new Error('Targeted PR refresh is unsupported; refresh the full PR.');
        const refreshed =
          pr && recapture
            ? await captureGitHub(
                deps,
                {
                  repository: pr.repository,
                  number: pr.number,
                  allowGitHub,
                },
                (await resolvePolicy(root)).exclusions,
              )
            : undefined;
        const acceptedRules = (await interaction.read(id)).rules
          .filter((rule) => rule.status === 'accepted')
          .map((rule) => rule.text);
        const session: ReviewSession = {
          version: 2,
          id: previous.id,
          revision: previous.revision + 1,
          createdAt: previous.createdAt,
          ...(await input(
            recapture ? refreshed : previous.snapshot,
            {
              ...(previous.snapshot.capture ??
                ({ kind: previous.snapshot.scope } satisfies Partial<CaptureRequest>)),
              ...(paths ? { paths } : {}),
            },
            recapture ? undefined : previous.context,
            options ?? previous.plan?.options,
            acceptedRules,
            !recapture &&
              (previous.policy.plugin ||
                previous.policy.sources.some((source) => source.format === 'shareable-policy-v1'))
              ? previous.policy
              : undefined,
          )),
        };
        await store.save(session);
        return session;
      }),
    execute,
    cancel: (id: string) =>
      serial(async () => {
        writable();
        const session = await store.get(id);
        if (!session) return null;
        if (session.status === 'queued' || session.status === 'running') {
          executionQueue.cancel(id);
          controllers.get(id)?.abort();
          cancelAgentStates(session);
          session.status = 'cancelled';
          session.state = 'interactive';
          session.completedAt = new Date().toISOString();
          await save(session);
        }
        return session;
      }),
    dismiss: (id: string, findingId: string, revision: number) =>
      serial(async () => {
        writable();
        const session = await store.get(id);
        if (!session) return null;
        if (session.revision !== revision)
          throw new Error('Session revision conflict. Reload before changing it.');
        const finding = session.findings.find((entry) => entry.id === findingId);
        if (!finding) return null;
        if (finding.status === 'dismissed') return session;
        finding.status = 'dismissed';
        await save(session);
        return session;
      }),
    delete: (id: string, revision: number) =>
      serial(async () => {
        writable();
        if (!store.delete) throw new Error('Durable storage is required for deletion.');
        if (controllers.has(id)) throw new Error('Cancel the active review before deletion.');
        return store.delete(id, revision);
      }),
    prune: (options: { before: string; keepLatest: number }) =>
      serial(async () => {
        writable();
        if (!store.prune) throw new Error('Durable storage is required for retention.');
        if (controllers.size)
          throw new Error('Wait for the active review before applying retention.');
        return store.prune(options);
      }),
    export: async (id: string, redact = true) => {
      if (!store.export) throw new Error('Durable storage is required for export.');
      return store.export(id, redact);
    },
    shutdown: async () => {
      stopping = true;
      await interaction.shutdown();
      if (deps.writable === false) return;
      await serial(async () => {
        for (const session of await store.list())
          if (session.status === 'queued') {
            executionQueue.cancel(session.id);
            cancelAgentStates(session);
            session.status = 'cancelled';
            session.state = 'interactive';
            session.completedAt = new Date().toISOString();
            session.error = 'Review cancelled during shutdown.';
            await save(session);
          }
        for (const [id, controller] of controllers) {
          controller.abort();
          const session = await store.get(id);
          if (session?.status === 'running') {
            cancelAgentStates(session);
            session.status = 'cancelled';
            session.state = 'interactive';
            session.completedAt = new Date().toISOString();
            session.error = 'Review cancelled during shutdown.';
            await save(session);
          }
        }
      });
    },
  };
};

export { effectivenessAnalytics, recommendPresets } from './analytics';
