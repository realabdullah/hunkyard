import { z } from 'zod';

const path = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      !value.split('/').some((part) => !part || ['.', '..', '.git', '.hunkyard'].includes(part)) &&
      !value.includes(':'),
  );
export const PatchRequestSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    runId: z.string().uuid(),
    file: path,
    replacement: z.string().max(50000),
    findingId: z.string().uuid().optional(),
  })
  .strict();
export const PatchSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  file: path,
  findingId: z.string().uuid().optional(),
  baseHash: z.string().regex(/^[a-f0-9]{64}$/),
  replacement: z.string().max(50000),
  preview: z.string(),
  createdAt: z.string().datetime(),
  status: z.enum(['proposed', 'approved', 'applying', 'applied', 'conflict']),
  approvalToken: z.string().uuid().optional(),
  approvedAt: z.string().datetime().optional(),
  isolated: z.boolean().optional(),
  destination: z.string().optional(),
  backup: z.string().optional(),
  error: z.string().optional(),
});
export const PatchApprovalSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    approved: z.literal(true),
    isolated: z.boolean().default(false),
  })
  .strict();
export const PatchApplySchema = z
  .object({ revision: z.number().int().nonnegative(), approvalToken: z.string().uuid() })
  .strict();
export type PatchProposal = z.infer<typeof PatchSchema>;
export const RuleSuggestionSchema = z.object({
  id: z.string().uuid(),
  text: z.string().min(1).max(4000),
  sourceFindingIds: z.array(z.string().uuid()).min(1),
  status: z.enum(['suggested', 'accepted', 'rejected']),
  createdAt: z.string().datetime(),
});
export const RuleDecisionSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    decision: z.enum(['accepted', 'rejected']),
    consent: z.literal(true),
  })
  .strict();

export const PatchDraftRequestSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    runId: z.string().uuid(),
    file: path,
    model: z.string().min(1).max(200).optional(),
  })
  .strict();
