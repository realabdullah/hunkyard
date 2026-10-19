import { z } from 'zod';
import { ProviderSchema } from './providers';

export type { Provider } from './providers';
export {
  hostedProviderOrigins,
  isHostedProvider,
  ProviderSchema,
  providerDefaults,
} from './providers';

import { PluginManifestSchema } from './plugin';
import { shareablePolicySchema } from './power-user';
import { PullRequestContextSchema } from './pull-request';

const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const safePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.split('/').includes('..') &&
      !path.includes('\0'),
    'Invalid repository-relative path',
  );
export const CaptureRequestSchema = z
  .object({
    kind: z
      .enum(['staged', 'unstaged', 'working-tree', 'branch', 'commit-range'])
      .default('staged'),
    includeUntracked: z.boolean().default(false),
    paths: z.array(safePath).max(200).default([]),
    baseRef: z.string().min(1).max(500).optional(),
    from: z.string().min(1).max(500).optional(),
    to: z.string().min(1).max(500).optional(),
    renameThreshold: z.number().int().min(1).max(100).default(50),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'branch' && !value.baseRef)
      ctx.addIssue({ code: 'custom', message: 'Branch scope requires baseRef' });
    if (value.kind === 'commit-range' && (!value.from || !value.to))
      ctx.addIssue({ code: 'custom', message: 'Commit range requires from and to' });
    if (value.includeUntracked && !['unstaged', 'working-tree'].includes(value.kind))
      ctx.addIssue({
        code: 'custom',
        message: 'Untracked inclusion requires a local working scope',
      });
  });
export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;
export const OmissionSchema = z.object({ path: safePath, reason: z.string().min(1) });
export const SnapshotFileChangeSchema = z.object({
  status: z.enum(['A', 'D', 'M', 'R', 'T']),
  oldPath: safePath.nullable(),
  newPath: safePath.nullable(),
  oldMode: z
    .string()
    .regex(/^\d{6}$/)
    .nullable(),
  newMode: z
    .string()
    .regex(/^\d{6}$/)
    .nullable(),
  oldOid: oid.nullable(),
  newOid: oid.nullable(),
  binary: z.boolean(),
});
export type SnapshotFileChange = z.infer<typeof SnapshotFileChangeSchema>;
export const SnapshotSchema = z.object({
  version: z.literal(2),
  id: z.string().uuid(),
  scope: z.enum(['staged', 'unstaged', 'working-tree', 'branch', 'commit-range']),
  capture: CaptureRequestSchema.optional(),
  pullRequest: PullRequestContextSchema.optional(),
  omissions: z.array(OmissionSchema).optional(),
  diagnostics: z.array(z.string()).optional(),
  repoRoot: z.string().min(1),
  repositoryGitDir: z.string().min(1),
  headSha: oid.nullable(),
  baseTree: oid,
  indexTree: oid,
  sourceIndexTree: oid.optional(),
  baseSha: oid.optional(),
  comparisonSha: oid.optional(),
  diff: z.string().max(350_000),
  diffHash: z.string().regex(/^[a-f0-9]{64}$/),
  gitVersion: z.string(),
  files: z.array(safePath),
  changes: z.array(SnapshotFileChangeSchema),
  sources: z.array(z.object({ oid, bytes: z.string(), text: z.string().nullable() })),
  createdAt: z.string().datetime(),
});
export type ReviewSnapshot = z.infer<typeof SnapshotSchema>;
export const FindingSchema = z.object({
  file: safePath,
  line: z.number().int().positive(),
  side: z.enum(['old', 'new']).default('new'),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info', 'major', 'minor']),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  title: z.string().min(1).max(300),
  explanation: z.string().min(1).max(8000),
  evidence: z.string().min(1).max(4000),
  recommendation: z.string().min(1).max(8000),
});
export const ReviewOutputSchema = z.object({ findings: z.array(FindingSchema).max(50) });
export type FindingDraft = z.infer<typeof FindingSchema>;
export const PolicySchema = z.object({
  plugin: PluginManifestSchema.optional(),
  version: z.literal(1),
  hash: z.string(),
  instructions: z.array(z.string()),
  sources: z.array(
    z.object({
      path: z.string(),
      hash: z.string(),
      truncated: z.boolean(),
      format: z.string().optional(),
      patterns: z.array(z.string()).optional(),
      content: z.string().optional(),
    }),
  ),
  exclusions: z.array(z.string()),
  fileRules: z.array(z.object({ path: safePath, sourcePaths: z.array(z.string()) })).optional(),
  conflicts: z
    .array(z.object({ path: safePath, sources: z.array(z.string()), resolution: z.string() }))
    .optional(),
  diagnostics: z.array(z.string()).optional(),
});
export type ReviewPolicyBundle = z.infer<typeof PolicySchema>;
export const ModelConfigSchema = z.object({
  provider: ProviderSchema.default('ollama'),
  endpoint: z.string().url().default('http://127.0.0.1:11434'),
  model: z.string().min(1).max(200).default('qwen2.5-coder:7b'),
  privacy: z.enum(['local-only', 'cloud-allowed']).default('local-only'),
  timeoutMs: z.number().int().min(100).max(600_000).default(120_000),
  maxTokens: z.number().int().min(256).max(16000).default(4000),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().gt(0).max(1).optional(),
  contextWindow: z.number().int().min(1024).max(2_000_000).optional(),
  maxReviewTokens: z.number().int().min(512).max(4_000_000).optional(),
  maxConcurrency: z.number().int().min(1).max(8).optional(),
  structuredOutput: z.enum(['json', 'schema', 'text']).optional(),
});
export const AgentIdSchema = z.enum([
  'correctness',
  'security',
  'frontend',
  'architecture',
  'testing',
  'verifier',
]);
export type AgentId = z.infer<typeof AgentIdSchema>;
export const profileAgents: Record<'quick' | 'standard' | 'deep', AgentId[]> = {
  quick: ['correctness'],
  standard: ['correctness', 'security', 'frontend'],
  deep: ['correctness', 'security', 'frontend', 'architecture', 'testing'],
};
export const profileTokenBudgets = { quick: 40000, standard: 120000, deep: 240000 };
export { cancelAgentStates, findingKey, validateReviewProvenance } from './review-quality';
export const WorkflowSchema = z
  .object({
    version: z.literal(1),
    nodes: z
      .array(
        z
          .object({
            agent: AgentIdSchema,
            after: z.array(AgentIdSchema).max(5).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict()
  .superRefine((graph, ctx) => {
    const nodes = new Map(graph.nodes.map((node) => [node.agent, node]));
    const error = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (nodes.size !== graph.nodes.length) error('Each agent can appear only once.');
    if (!graph.nodes.some((node) => node.agent !== 'verifier'))
      error('A workflow requires a specialist.');
    const visiting = new Set<AgentId>();
    const done = new Set<AgentId>();
    const visit = (id: AgentId) => {
      if (visiting.has(id)) {
        error('Workflow contains a cycle.');
        return;
      }
      if (done.has(id)) return;
      visiting.add(id);
      for (const dependency of nodes.get(id)?.after ?? []) {
        if (!nodes.has(dependency)) error('Workflow dependency is missing.');
        else if (dependency === 'verifier') error('Verifier must be terminal.');
        else visit(dependency);
      }
      visiting.delete(id);
      done.add(id);
    };
    for (const node of graph.nodes) {
      if (new Set(node.after).size !== node.after.length) error('Duplicate dependency.');
      visit(node.agent);
    }
    const verifier = nodes.get('verifier');
    if (
      verifier &&
      graph.nodes.some((node) => node.agent !== 'verifier' && !verifier.after.includes(node.agent))
    )
      error('Verifier must depend on every specialist.');
  });
export type Workflow = z.infer<typeof WorkflowSchema>;
export const ReviewOptionsSchema = z
  .object({
    profile: z.enum(['quick', 'standard', 'deep']).default('quick'),
    workflow: WorkflowSchema.optional(),
    verify: z.boolean().default(false),
    priority: z.enum(['interactive', 'background']).default('interactive'),
    concurrency: z.number().int().min(1).max(8).default(1),
    retries: z.number().int().min(0).max(2).default(0),
    tokenBudget: z.number().int().min(512).max(4000000).optional(),
    maxCostUsd: z.number().finite().nonnegative().optional(),
    agentModels: z
      .record(AgentIdSchema, ModelConfigSchema.partial().omit({ privacy: true }).strict())
      .default({}),
    prices: z
      .record(
        AgentIdSchema,
        z
          .object({
            inputPerMillion: z.number().finite().nonnegative(),
            outputPerMillion: z.number().finite().nonnegative(),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();
export type ReviewOptions = z.infer<typeof ReviewOptionsSchema>;
export const UserConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    model: ModelConfigSchema.default({}),
    review: ReviewOptionsSchema.optional(),
    rules: z.array(z.string().max(4000)).max(100).default([]),
    cloudConsent: z.record(z.boolean()).default({}),
    contextCloudConsent: z.record(z.boolean()).optional(),
    cloudDestinations: z.record(z.array(z.string().url()).max(10)).optional(),
  })
  .strict();
export const ProjectConfigSchema = z
  .object({
    rules: z.array(z.string().max(4000)).max(100).default([]),
    exclude: z.array(safePath).max(100).default([]),
    instructionSources: z
      .array(z.enum(['agents', 'claude', 'copilot', 'cursor', 'pr-agent', 'hunkyard']))
      .optional(),
    instructionOrder: z.array(safePath).max(100).default([]),
    contextBytes: z.number().int().min(1024).max(100000).default(24000),
  })
  .strict();
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export const ModelTargetSchema = ModelConfigSchema.extend({
  cloudConsent: z.boolean(),
  approvedHostedOrigins: z.array(z.string().url()).max(10).optional(),
  repository: z.string(),
});
export type ModelTarget = z.infer<typeof ModelTargetSchema>;
export { assertCurrentAuthorization, validateTarget } from './targets';
export const ReviewPlanSchema = z.object({
  options: ReviewOptionsSchema,
  baseTarget: ModelTargetSchema,
  agents: z
    .array(z.object({ id: AgentIdSchema, target: ModelTargetSchema }))
    .min(1)
    .max(6),
  maxTokens: z.number().int().positive(),
});
export type ReviewPlan = z.infer<typeof ReviewPlanSchema>;
export const AgentAttributionSchema = z.object({
  agent: AgentIdSchema,
  target: ModelTargetSchema,
  promptVersion: z.literal('specialists-v1'),
});
export const OrchestrationSchema = z.object({
  reservedTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().finite().nonnegative(),
  reportedInputTokens: z.number().int().nonnegative(),
  reportedOutputTokens: z.number().int().nonnegative(),
  usageComplete: z.boolean(),
  costComplete: z.boolean(),
  agents: z.array(
    z.object({
      id: AgentIdSchema,
      status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
      attempts: z.number().int().nonnegative(),
      findings: z.array(FindingSchema),
      error: z.string().optional(),
    }),
  ),
});
export type Orchestration = z.infer<typeof OrchestrationSchema>;
export const StartReviewSchema = z
  .object({
    scope: CaptureRequestSchema,
    review: ReviewOptionsSchema.optional(),
  })
  .strict();
export const ContextManifestSchema = z.object({
  id: z.string().uuid(),
  snapshotId: z.string().uuid(),
  policyHash: z.string(),
  promptVersion: z.literal('correctness-v1'),
  files: z.array(safePath),
  excludedFiles: z.array(safePath),
  redacted: z.literal(true),
  maxInputTokens: z.number().int().positive(),
  createdAt: z.string().datetime(),
  entries: z
    .array(
      z.object({
        path: safePath,
        oid,
        reason: z.enum(['surrounding', 'import', 'symbol', 'test', 'reference', 'semantic']),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        text: z.string(),
        hash: z.string(),
      }),
    )
    .optional(),
  omissions: z.array(OmissionSchema).optional(),
  usedBytes: z.number().int().nonnegative().optional(),
  semantic: z
    .object({
      provider: z.enum(['ollama', 'compatible']),
      model: z.string(),
      endpoint: z.string(),
      candidates: z.number().int().nonnegative(),
      version: z.literal(1),
    })
    .strict()
    .optional(),
});
export type ContextManifest = z.infer<typeof ContextManifestSchema>;
export const DomainEventSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  cursor: z.number().int().positive(),
  type: z.enum([
    'session.created',
    'snapshot.captured',
    'context.resolved',
    'run.queued',
    'run.started',
    'agent.started',
    'agent.progress',
    'finding.validated',
    'finding.dismissed',
    'run.completed',
    'run.failed',
    'run.cancelled',
  ]),
  createdAt: z.string().datetime(),
  data: z.record(z.union([z.string(), z.number(), z.boolean()])),
});
export type DomainEvent = z.infer<typeof DomainEventSchema>;
export const SessionSchema = z.object({
  version: z.literal(2),
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  runId: z.string().uuid().optional(),
  state: z.enum(['ready', 'reviewing', 'interactive', 'archived']).optional(),
  /** Frozen for the developer to read in Walkthrough mode; no reviewer ran on this run. */
  walkthroughOnly: z.literal(true).optional(),
  startedAt: z.string().datetime().optional(),
  context: ContextManifestSchema.optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  snapshot: SnapshotSchema,
  policy: PolicySchema,
  target: ModelTargetSchema,
  plan: ReviewPlanSchema.optional(),
  orchestration: OrchestrationSchema.optional(),
  findings: z.array(
    FindingSchema.extend({
      id: z.string().uuid(),
      status: z.enum(['open', 'dismissed']),
      snapshotId: z.string().uuid(),
      runId: z.string().uuid().optional(),
      contextManifestId: z.string().uuid().optional(),
      ruleRefs: z.array(z.string()).optional(),
      model: z.string(),
      provider: ProviderSchema,
      policyHash: z.string(),
      promptVersion: z.enum(['correctness-v1', 'specialists-v1']),
      attributions: z.array(AgentAttributionSchema).min(1).max(6).optional(),
      verified: z.boolean().optional(),
    }),
  ),
  instructions: z.array(z.string()),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});
export type ReviewSession = z.infer<typeof SessionSchema>;
export type Finding = ReviewSession['findings'][number];
export type ReviewStatus = ReviewSession['status'];
export {
  changedLines,
  diffSections,
  excludedPath,
  matchesPath,
  reviewRulePaths,
  validateFindings,
} from './ranges';

export type SessionSummary = Pick<
  ReviewSession,
  'id' | 'revision' | 'status' | 'target' | 'createdAt'
> & {
  snapshot: Pick<ReviewSnapshot, 'files'> &
    Partial<Pick<ReviewSnapshot, 'scope'>> & {
      pullRequest?: { number: number; title: string };
    };
  findingCount?: number;
};

export const OllamaChatSchema = z.object({
  message: z.object({ content: z.string() }),
  done_reason: z.string().optional(),
});
export const OpenAIChatSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.string().optional(),
      }),
    )
    .min(1),
});
/** One NDJSON line of an Ollama `/api/chat` stream. */
export const OllamaChatChunkSchema = z.union([
  z.object({ error: z.string() }),
  z.object({
    message: z.object({ content: z.string() }).optional(),
    done: z.boolean(),
    done_reason: z.string().optional(),
  }),
]);
/** One `data:` payload of an OpenAI-compatible Chat Completions stream. */
export const OpenAIChatChunkSchema = z.union([
  z.object({ error: z.object({ message: z.string() }) }),
  z.object({
    choices: z.array(
      z.object({
        delta: z.object({ content: z.string().nullish() }).optional(),
        finish_reason: z.string().nullish(),
      }),
    ),
  }),
]);
export const OllamaModelsSchema = z.object({ models: z.array(z.object({ name: z.string() })) });
export const OpenAIModelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

export const RunRequestSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    recapture: z.boolean().default(false),
    review: ReviewOptionsSchema.optional(),
    paths: z.array(safePath).max(200).optional(),
  })
  .strict()
  .refine((value) => !value.paths?.length || value.recapture, 'Targeted rerun requires recapture');
export const RevisionRequestSchema = z
  .object({ revision: z.number().int().nonnegative() })
  .strict();
export const ExportRequestSchema = z.object({ includeSource: z.boolean().default(false) }).strict();
export const RetentionRequestSchema = z
  .object({
    before: z.string().datetime(),
    keepLatest: z.number().int().min(0).max(100000),
  })
  .strict();
export const SecretRequestSchema = z
  .object({
    provider: ProviderSchema,
    secret: z.string().min(1).max(4096).nullable(),
  })
  .strict();

export type {
  FindingStatus,
  Interaction,
  MessageRequest,
  Walkthrough,
  WalkthroughRequest,
} from './interaction';

export {
  CitationSchema,
  DismissReasonSchema,
  emptyInteraction,
  FindingStatusSchema,
  InteractionSchema,
  MessageRequestSchema,
  ReactionRequestSchema,
  StatusRequestSchema,
  WalkthroughRequestSchema,
  WalkthroughSchema,
} from './interaction';
export type { PatchProposal } from './patch';

export {
  PatchApplySchema,
  PatchApprovalSchema,
  PatchDraftRequestSchema,
  PatchRequestSchema,
  PatchSchema,
  RuleDecisionSchema,
} from './patch';
export { type PluginManifest, PluginManifestSchema, type PluginPermission } from './plugin';
export * from './pull-request';
export { redactSecrets } from './redaction';

export const ShareablePolicySchema = shareablePolicySchema(ReviewOptionsSchema, safePath);
export type ShareablePolicy = z.infer<typeof ShareablePolicySchema>;
export type { BenchmarkReport } from './power-user';
export { BenchmarkReportSchema } from './power-user';
