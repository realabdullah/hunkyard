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
export const InteractionSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  sessionId: z.string().uuid(),
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
