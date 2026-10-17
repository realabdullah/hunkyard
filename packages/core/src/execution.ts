import {
  assertCurrentAuthorization,
  excludedPath,
  type FindingDraft,
  type ModelTarget,
  ReviewOutputSchema,
  type ReviewPolicyBundle,
  type ReviewSession,
  reviewRulePaths,
  validateFindings,
} from '@reviewlab/domain';
import { runReviewPlan } from './orchestration';
import type { ReviewServiceDependencies } from './ports';

export const createReviewExecutor = (
  deps: Pick<
    ReviewServiceDependencies,
    'root' | 'store' | 'agent' | 'loadTarget' | 'prepareInstructions'
  > & {
    controllers: Map<string, AbortController>;
    writable: () => void;
    serial: <T>(operation: () => Promise<T>) => Promise<T>;
    save: (session: ReviewSession) => Promise<void>;
  },
) => {
  const { root, store, agent, loadTarget, controllers, writable, serial, save } = deps;
  return async (id: string): Promise<void> => {
    writable();
    const session = await serial(async () => {
      const current = await store.get(id);
      if (current?.status !== 'queued') return null;
      if (controllers.size >= (current.target.maxConcurrency ?? 1))
        throw new Error('The configured review concurrency limit is reached.');
      controllers.set(id, new AbortController());
      current.status = 'running';
      current.state = 'reviewing';
      current.startedAt = new Date().toISOString();
      try {
        await save(current);
      } catch (error) {
        controllers.delete(id);
        throw error;
      }
      return current;
    });
    if (!session) return;
    const controller = controllers.get(id);
    if (!controller) return;
    try {
      const currentTarget = await loadTarget(root);
      assertCurrentAuthorization(session.target, currentTarget);
      const instructions = deps.prepareInstructions
        ? deps.prepareInstructions(
            session.policy,
            reviewRulePaths(session.snapshot, session.context?.files ?? session.snapshot.files),
          )
        : session.instructions;
      const drafts: (FindingDraft & {
        attributions?: ReviewSession['findings'][number]['attributions'];
        verified?: boolean;
      })[] = session.plan
        ? await runReviewPlan({
            session: { ...session, plan: session.plan },
            agent,
            instructions,
            signal: controller.signal,
            authorize: async (route) => {
              const current = await loadTarget(root);
              assertCurrentAuthorization(route, current);
            },
            changed: async (orchestration, message) => {
              await serial(async () => {
                const current = await store.get(id);
                if (!current || current.status !== 'running' || current.runId !== session.runId)
                  return;
                current.orchestration = orchestration;
                await save(current);
                if (session.runId && store.progress)
                  await store.progress(id, session.runId, message);
              });
            },
          })
        : validateFindings(
            session.snapshot,
            ReviewOutputSchema.parse({
              findings: await agent.review({
                ...(session.policy.plugin ? { plugin: session.policy.plugin } : {}),
                snapshot: session.snapshot,
                instructions: deps.prepareInstructions
                  ? deps.prepareInstructions(
                      session.policy,
                      reviewRulePaths(
                        session.snapshot,
                        session.context?.files ?? session.snapshot.files,
                      ),
                    )
                  : session.instructions,
                ...(session.context ? { context: session.context } : {}),
                target: session.target,
                exclusions: session.policy.exclusions,
                signal: controller.signal,
                onProgress: async (progress) => {
                  if (session.runId && store.progress)
                    await store.progress(
                      id,
                      session.runId,
                      `${progress.stage} (attempt ${progress.attempt})`,
                    );
                },
              }),
            }).findings,
          );
      if (
        session.context?.entries &&
        drafts.some(
          (finding) =>
            !session.snapshot.changes.some(
              (change) =>
                (finding.side === 'old' ? change.oldPath : change.newPath) === finding.file &&
                session.context?.files.includes(change.newPath ?? change.oldPath ?? ''),
            ),
        )
      )
        throw new Error('Model cited a source omitted by the context budget.');
      if (drafts.some((finding) => excludedPath(finding.file, session.policy.exclusions)))
        throw new Error('Model cited an excluded source.');
      await serial(async () => {
        const current = await store.get(id);
        if (!current || current.status !== 'running' || current.runId !== session.runId) return;
        current.findings = drafts.map((finding) => ({
          ...finding,
          id: globalThis.crypto.randomUUID(),
          status: 'open',
          snapshotId: session.snapshot.id,
          model: finding.attributions?.[0]?.target.model ?? session.target.model,
          provider: finding.attributions?.[0]?.target.provider ?? session.target.provider,
          policyHash: session.policy.hash,
          promptVersion: session.plan ? 'specialists-v1' : 'correctness-v1',
          ruleRefs:
            session.policy.fileRules?.find((rule) => rule.path === finding.file)?.sourcePaths ??
            session.policy.sources.map((source) => source.path),
          ...(session.runId ? { runId: session.runId } : {}),
          ...(session.context ? { contextManifestId: session.context.id } : {}),
        }));
        current.status = 'completed';
        current.state = 'interactive';
        current.completedAt = new Date().toISOString();
        await save(current);
      });
    } catch (error) {
      await serial(async () => {
        const current = await store.get(id);
        if (!current || current.status !== 'running' || current.runId !== session.runId) return;
        current.status = controller.signal.aborted ? 'cancelled' : 'failed';
        current.state = 'interactive';
        current.error = controller.signal.aborted
          ? 'Review cancelled.'
          : error instanceof Error
            ? error.message
            : 'Review failed.';
        current.completedAt = new Date().toISOString();
        await save(current);
      });
    } finally {
      controllers.delete(id);
    }
  };
};
