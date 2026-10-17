import { z } from 'zod';
import type { ReviewOptionsSchema, safePath } from './index';

export const shareablePolicySchema = (review: typeof ReviewOptionsSchema, path: typeof safePath) =>
  z
    .object({
      version: z.literal(1),
      name: z.string().trim().min(1).max(100),
      rules: z.array(z.string().trim().min(1).max(4000)).max(20),
      exclude: z.array(path).max(100),
      review: review.omit({ agentModels: true, prices: true }),
    })
    .strict();

const count = z.number().int().nonnegative();
export const BenchmarkReportSchema = z
  .object({
    synthetic: z.boolean(),
    rows: z
      .array(
        z
          .object({
            model: z.string().min(1).max(200),
            profile: z.enum(['quick', 'standard', 'deep']),
            verify: z.boolean(),
            status: z.string(),
            truePositives: count,
            falsePositives: count,
            recall: z.number().finite().min(0).max(1),
            precision: z.number().finite().min(0).max(1),
            rawCandidates: count,
            finalFindings: count,
            reservedTokens: count,
            elapsedMs: z.number().finite().nonnegative().optional(),
            error: z.string().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();
export type BenchmarkReport = z.infer<typeof BenchmarkReportSchema>;
