import { z } from 'zod';
import { PatchSchema, RuleSuggestionSchema } from './patch';
import { PublicationSchema } from './pull-request';

export const FindingStatusSchema = z.enum([
  'open',
  'investigating',
  'accepted',
  'fixed',
  'dismissed',
  'stale',
  'reintroduced',
]);
export const DismissReasonSchema = z.enum([
  'false-positive',
  'preference',
  'accepted-risk',
  'duplicate',
  'out-of-scope',
]);
export const CitationSchema = z
  .object({
    runId: z.string().uuid(),
    snapshotId: z.string().uuid(),
    findingId: z.string().uuid(),
  })
  .strict();
export const MessageRequestSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    text: z.string().trim().min(1).max(8000),
    findingId: z.string().uuid().optional(),
    runId: z.string().uuid(),
    parentId: z.string().uuid().optional(),
    citations: z.array(CitationSchema).max(20).default([]),
    kind: z.enum(['note', 'decision', 'question']).default('note'),
    model: z.string().min(1).max(200).optional(),
  })
  .strict();
export const StatusRequestSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    runId: z.string().uuid(),
    status: FindingStatusSchema,
    reason: DismissReasonSchema.optional(),
    note: z.string().trim().max(4000).default(''),
  })
  .strict()
  .refine(
    (value) => value.status !== 'dismissed' || value.reason !== undefined,
    'Dismissal requires a reason',
  );
/** The reviewer's own pass over a frozen snapshot: files read, line notes and the final verdict. */
export const WalkthroughSchema = z.object({
  reviewed: z
    .array(
      z.object({
        snapshotId: z.string().uuid(),
        path: z.string().min(1),
        at: z.string().datetime(),
      }),
    )
    .default([]),
  notes: z
    .array(
      z.object({
        id: z.string().uuid(),
        snapshotId: z.string().uuid(),
        path: z.string().min(1),
        side: z.enum(['old', 'new']),
        /** `null` is a note on the whole file. */
        line: z.number().int().positive().nullable(),
        text: z.string().min(1).max(4000),
        createdAt: z.string().datetime(),
      }),
    )
    .default([]),
  verdicts: z
    .array(
      z.object({
        id: z.string().uuid(),
        snapshotId: z.string().uuid(),
        decision: z.enum(['approve', 'request-changes']),
        /** The exact text handed to the coding agent. */
        handoff: z.string().min(1).max(64_000),
        createdAt: z.string().datetime(),
      }),
    )
    .default([]),
});
export type Walkthrough = z.infer<typeof WalkthroughSchema>;
const revision = z.number().int().nonnegative();
export const WalkthroughRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('review'),
      revision,
      snapshotId: z.string().uuid(),
      path: z.string().min(1).max(4096),
      reviewed: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal('note'),
      revision,
      snapshotId: z.string().uuid(),
      path: z.string().min(1).max(4096),
      side: z.enum(['old', 'new']).default('new'),
      line: z.number().int().positive().nullable(),
      text: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z.object({ action: z.literal('remove-note'), revision, noteId: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal('verdict'),
      revision,
      snapshotId: z.string().uuid(),
      decision: z.enum(['approve', 'request-changes']),
      handoff: z.string().trim().min(1).max(64_000),
    })
    .strict(),
]);
export type WalkthroughRequest = z.input<typeof WalkthroughRequestSchema>;
export const InteractionSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  sessionId: z.string().uuid(),
  walkthrough: WalkthroughSchema.default({}),
  comparisons: z
    .array(
      z.object({
        runId: z.string().uuid(),
        previousRunId: z.string().uuid(),
        oldFindingId: z.string().uuid(),
        newFindingId: z.string().uuid().optional(),
        outcome: z.enum(['matched', 'reintroduced', 'stale', 'uncertain']),
        note: z.string(),
      }),
    )
    .default([]),
  publications: z.array(PublicationSchema).default([]),
  patches: z.array(PatchSchema).default([]),
  rules: z.array(RuleSuggestionSchema).default([]),
  messages: z.array(
    z.object({
      id: z.string().uuid(),
      runId: z.string().uuid(),
      snapshotId: z.string().uuid(),
      findingId: z.string().uuid().optional(),
      parentId: z.string().uuid().optional(),
      actor: z.enum(['user', 'assistant']),
      kind: z.enum(['note', 'decision', 'question', 'answer']),
      text: z.string().min(1).max(8000),
      createdAt: z.string().datetime(),
      citations: z.array(CitationSchema),
      target: z
        .object({
          provider: z.string(),
          model: z.string(),
          endpoint: z.string(),
          privacy: z.string(),
        })
        .optional(),
      reactions: z.array(z.enum(['helpful', 'disagree'])).default([]),
    }),
  ),
  transitions: z.array(
    z.object({
      id: z.string().uuid(),
      runId: z.string().uuid(),
      snapshotId: z.string().uuid(),
      findingId: z.string().uuid(),
      from: FindingStatusSchema,
      to: FindingStatusSchema,
      actor: z.enum(['user', 'system']),
      reason: DismissReasonSchema.optional(),
      note: z.string(),
      createdAt: z.string().datetime(),
    }),
  ),
});
export type Interaction = z.infer<typeof InteractionSchema>;
export type FindingStatus = z.infer<typeof FindingStatusSchema>;
export type MessageRequest = z.infer<typeof MessageRequestSchema>;
export const emptyInteraction = (sessionId: string): Interaction => ({
  version: 1,
  revision: 0,
  sessionId,
  walkthrough: { reviewed: [], notes: [], verdicts: [] },
  messages: [],
  transitions: [],
  patches: [],
  publications: [],
  rules: [],
  comparisons: [],
});
export const ReactionRequestSchema = z
  .object({ revision: z.number().int().nonnegative(), reaction: z.enum(['helpful', 'disagree']) })
  .strict();
