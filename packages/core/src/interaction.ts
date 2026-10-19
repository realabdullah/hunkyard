import {
  emptyInteraction,
  type FindingStatus,
  type Interaction,
  MessageRequestSchema,
  PatchDraftRequestSchema,
  ReactionRequestSchema,
  StatusRequestSchema,
  WalkthroughRequestSchema,
} from '@hunkyard/domain';
import { effectiveStatus } from './finding-status';
import type { InteractionAccess } from './interaction-access';
import type { ReviewServiceDependencies } from './ports';
import { createReconciliation } from './reconciliation';
import { createRemediationService } from './remediation';

const allowed: Record<FindingStatus, FindingStatus[]> = {
  open: ['investigating', 'accepted', 'dismissed', 'fixed', 'stale'],
  investigating: ['open', 'accepted', 'dismissed', 'fixed', 'stale'],
  accepted: ['open', 'investigating', 'fixed', 'dismissed', 'stale'],
  fixed: ['open', 'reintroduced', 'stale'],
  dismissed: ['open', 'investigating', 'reintroduced', 'stale'],
  stale: ['open', 'investigating', 'reintroduced', 'dismissed'],
  reintroduced: ['open', 'investigating', 'accepted', 'fixed', 'dismissed', 'stale'],
};
export const createInteractionService = (deps: ReviewServiceDependencies, writable: () => void) => {
  const pending = new Set<AbortController>();
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const read = async (id: string) => {
    if (!(await deps.store.get(id))) throw new Error('Session not found.');
    return deps.store.interaction ? deps.store.interaction(id) : emptyInteraction(id);
  };
  const save = async (state: Interaction) => {
    if (!deps.store.saveInteraction) throw new Error('Durable interaction storage required.');
    const expected = state.revision;
    state.revision += 1;
    await deps.store.saveInteraction(state, expected);
  };
  const check = (state: Interaction, revision: number) => {
    if (state.revision !== revision)
      throw new Error('Interaction revision conflict. Reload before changing it.');
  };
  const run = async (id: string, runId: string) => {
    const latest = await deps.store.get(id);
    const found =
      (latest?.runId ?? latest?.id) === runId
        ? latest
        : (await deps.store.runs?.(id))?.find((entry) => (entry.runId ?? entry.id) === runId);
    if (!found) throw new Error('Run not found in this session.');
    return found;
  };
  const snapshotOf = async (id: string, snapshotId: string) => {
    const latest = await deps.store.get(id);
    const sessions = [...(latest ? [latest] : []), ...((await deps.store.runs?.(id)) ?? [])];
    const found = sessions.find((entry) => entry.snapshot.id === snapshotId)?.snapshot;
    if (!found) throw new Error('Snapshot not found in this session.');
    return found;
  };
  /** Records the reviewer's own walkthrough: reviewed files, line notes and verdicts. */
  const walkthrough = (id: string, raw: unknown) =>
    serial(async () => {
      writable();
      const input = WalkthroughRequestSchema.parse(raw);
      const state = await read(id);
      check(state, input.revision);
      const pass = state.walkthrough;
      const now = new Date().toISOString();
      if (input.action === 'remove-note') {
        if (!pass.notes.some((note) => note.id === input.noteId))
          throw new Error('Note not found.');
        pass.notes = pass.notes.filter((note) => note.id !== input.noteId);
      } else {
        const snapshot = await snapshotOf(id, input.snapshotId);
        if (input.action !== 'verdict' && !snapshot.files.includes(input.path))
          throw new Error('File is not part of this snapshot.');
        if (input.action === 'review') {
          const same = (entry: { snapshotId: string; path: string }) =>
            entry.snapshotId === input.snapshotId && entry.path === input.path;
          const has = pass.reviewed.some(same);
          if (has === input.reviewed) return state;
          pass.reviewed = input.reviewed
            ? [...pass.reviewed, { snapshotId: input.snapshotId, path: input.path, at: now }]
            : pass.reviewed.filter((entry) => !same(entry));
        } else if (input.action === 'note') {
          pass.notes.push({
            id: globalThis.crypto.randomUUID(),
            snapshotId: input.snapshotId,
            path: input.path,
            side: input.side,
            line: input.line,
            text: input.text,
            createdAt: now,
          });
        } else {
          pass.verdicts.push({
            id: globalThis.crypto.randomUUID(),
            snapshotId: input.snapshotId,
            decision: input.decision,
            handoff: input.handoff,
            createdAt: now,
          });
        }
      }
      await save(state);
      return state;
    });
  /**
   * `onDelta` receives a question's answer text live; only the validated whole is saved.
   * `cancel` lets the caller stop the model call; the question stays saved either way.
   */
  const message = async (
    id: string,
    raw: unknown,
    onDelta?: (text: string) => void,
    cancel?: AbortSignal,
  ) => {
    const input = MessageRequestSchema.parse(raw);
    if (input.kind === 'question' && pending.size)
      throw new Error(
        'A conversation answer is already active. Wait for it before another model question.',
      );
    const controller = new AbortController();
    const saved = await serial(async () => {
      writable();
      if (input.kind === 'question' && pending.size)
        throw new Error('A conversation answer is already active.');
      const state = await read(id);
      check(state, input.revision);
      const session = await run(id, input.runId);
      if (input.findingId && !session.findings.some((finding) => finding.id === input.findingId))
        throw new Error('Finding not found in this run.');
      if (
        input.parentId &&
        !state.messages.some(
          (entry) =>
            entry.id === input.parentId &&
            entry.runId === input.runId &&
            entry.findingId === input.findingId,
        )
      )
        throw new Error('Reply parent must belong to the same thread.');
      for (const citation of input.citations) {
        const cited = await run(id, citation.runId);
        if (
          cited.snapshot.id !== citation.snapshotId ||
          !cited.findings.some((finding) => finding.id === citation.findingId)
        )
          throw new Error('Citation does not identify retained evidence.');
      }
      const entry: Interaction['messages'][number] = {
        id: globalThis.crypto.randomUUID(),
        runId: input.runId,
        snapshotId: session.snapshot.id,
        ...(input.findingId ? { findingId: input.findingId } : {}),
        ...(input.parentId ? { parentId: input.parentId } : {}),
        actor: 'user',
        kind: input.kind,
        text: input.text,
        citations: input.citations,
        createdAt: new Date().toISOString(),
        reactions: [],
      };
      state.messages.push(entry);
      await save(state);
      if (input.kind === 'question') pending.add(controller);
      return { state, entry, session };
    });
    if (input.kind !== 'question') return saved.state;
    const stop = () => controller.abort();
    cancel?.addEventListener('abort', stop, { once: true });
    if (cancel?.aborted) stop();
    try {
      writable();
      if (!deps.respond) throw new Error('Question saved. Model conversations are unavailable.');
      const response = await deps.respond({
        session: saved.session,
        state: saved.state,
        message: saved.entry,
        ...(input.model ? { model: input.model } : {}),
        signal: controller.signal,
        ...(onDelta ? { onDelta } : {}),
      });
      return await serial(async () => {
        writable();
        const state = await read(id);
        const text = response.text.trim();
        if (!text || text.length > 8000)
          throw new Error(
            'Model answer exceeded the conversation contract. Question remains saved.',
          );
        state.messages.push({
          ...saved.entry,
          id: globalThis.crypto.randomUUID(),
          parentId: saved.entry.id,
          actor: 'assistant',
          kind: 'answer',
          text,
          createdAt: new Date().toISOString(),
          target: {
            provider: response.target.provider,
            model: response.target.model,
            endpoint: response.target.endpoint,
            privacy: response.target.privacy,
          },
          reactions: [],
        });
        await save(state);
        return state;
      });
    } finally {
      cancel?.removeEventListener('abort', stop);
      pending.delete(controller);
    }
  };
  const access: InteractionAccess = { serial, writable, read, save, check, run };
  const draftPatch = async (id: string, raw: unknown): Promise<Interaction> => {
    writable();
    const input = PatchDraftRequestSchema.parse(raw);
    if (!deps.patch) throw new Error('Patch adapter unavailable.');
    const session = await run(id, input.runId);
    const source = deps.patch.source(session, input.file);
    const finding = session.findings.find((entry) => entry.file === input.file);
    const state = await message(id, {
      revision: input.revision,
      runId: input.runId,
      ...(finding ? { findingId: finding.id } : {}),
      kind: 'question',
      text: `Draft a suggested fix for ${input.file}. Return only the full replacement file, with no markdown fences or commentary. Do not change unrelated behavior. The user will review and separately approve the exact patch. Frozen full source:\n${source}`,
      ...(input.model ? { model: input.model } : {}),
    });
    const answer = state.messages[state.messages.length - 1];
    if (!answer || answer.actor !== 'assistant') throw new Error('No patch draft answer.');
    return service.propose(id, {
      revision: state.revision,
      runId: input.runId,
      file: input.file,
      replacement: answer.text,
      ...(finding ? { findingId: finding.id } : {}),
    });
  };
  const service = {
    draftPatch,
    shutdown: async () => {
      for (const controller of pending) controller.abort();
      await queue;
    },
    read,
    message,
    walkthrough,
    reconcile: createReconciliation(deps, access),
    ...createRemediationService(deps, access),
    transition: (id: string, findingId: string, raw: unknown) =>
      serial(async () => {
        writable();
        const input = StatusRequestSchema.parse(raw);
        const state = await read(id);
        check(state, input.revision);
        const session = await run(id, input.runId);
        const finding = session.findings.find((entry) => entry.id === findingId);
        if (!finding) throw new Error('Finding not found in this run.');
        const from = effectiveStatus(state, input.runId, finding);
        if (from === input.status) return state;
        if (!allowed[from].includes(input.status))
          throw new Error(
            `Cannot transition ${from} to ${input.status}. Reopen the finding first.`,
          );
        state.transitions.push({
          id: globalThis.crypto.randomUUID(),
          runId: input.runId,
          snapshotId: session.snapshot.id,
          findingId,
          from,
          to: input.status,
          actor: 'user',
          note: input.note,
          ...(input.reason ? { reason: input.reason } : {}),
          createdAt: new Date().toISOString(),
        });
        await save(state);
        return state;
      }),
    react: (id: string, messageId: string, raw: unknown) =>
      serial(async () => {
        writable();
        const input = ReactionRequestSchema.parse(raw);
        const state = await read(id);
        check(state, input.revision);
        const entry = state.messages.find((entry) => entry.id === messageId);
        if (!entry) throw new Error('Message not found.');
        entry.reactions = entry.reactions.includes(input.reaction)
          ? entry.reactions.filter((value) => value !== input.reaction)
          : [...entry.reactions, input.reaction];
        await save(state);
        return state;
      }),
  };
  return service;
};
