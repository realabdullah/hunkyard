import type {
  AgentId,
  ContextManifest,
  DomainEvent,
  FindingDraft,
  Interaction,
  ModelTarget,
  PatchProposal,
  Publication,
  PullRequestRequest,
  ReviewOptions,
  ReviewPolicyBundle,
  ReviewSession,
  ReviewSnapshot,
} from '@reviewlab/domain';
export type ReviewAgent = {
  review(input: {
    plugin?: import('@reviewlab/domain').PluginManifest;
    agentId?: AgentId;
    candidates?: FindingDraft[];
    reserve?: (input: number, output: number) => void;
    onUsage?: (input: number | undefined, output: number | undefined) => void;
    snapshot: ReviewSnapshot;
    instructions: string[];
    target: ModelTarget;
    exclusions: string[];
    context?: ContextManifest;
    signal: AbortSignal;
    onProgress?: (progress: {
      stage: 'request' | 'response' | 'repair';
      attempt: number;
    }) => void | Promise<void>;
  }): Promise<FindingDraft[]>;
};
export type SessionStore = {
  save(session: ReviewSession): Promise<void>;
  get(id: string): Promise<ReviewSession | null>;
  list(): Promise<ReviewSession[]>;
  runs?(id: string): Promise<ReviewSession[]>;
  snapshots?(id: string): Promise<ReviewSnapshot[]>;
  events?(id: string, after: number): Promise<DomainEvent[]>;
  progress?(id: string, runId: string, message: string): Promise<void>;
  delete?(id: string, revision: number): Promise<boolean>;
  prune?(input: { before: string; keepLatest: number }): Promise<number>;
  export?(id: string, redact: boolean): Promise<unknown>;
  interaction?(id: string): Promise<Interaction>;
  saveInteraction?(state: Interaction, expected: number): Promise<void>;
  usage?(): Promise<{ sessions: number; runs: number; snapshots: number; bytes: number }>;
};

export type ReviewServiceDependencies = {
  store: SessionStore;
  agent: ReviewAgent;
  root: string;
  captureStaged: (root: string) => Promise<ReviewSnapshot>;
  capture?: (root: string, request: unknown, exclusions: string[]) => Promise<ReviewSnapshot>;
  buildContext?: (
    snapshot: ReviewSnapshot,
    policy: ReviewPolicyBundle,
    target: ModelTarget,
    previous?: ContextManifest,
  ) => Promise<ContextManifest>;
  prepareInstructions?: (policy: ReviewPolicyBundle, files: string[]) => string[];
  resolvePolicy: (root: string, files?: string[]) => Promise<ReviewPolicyBundle>;
  loadTarget: (root: string) => Promise<ModelTarget>;
  loadReviewOptions?: (root: string) => Promise<ReviewOptions>;
  respond?: (input: {
    session: ReviewSession;
    state: Interaction;
    message: Interaction['messages'][number];
    model?: string;
    signal: AbortSignal;
    onDelta?: (text: string) => void;
  }) => Promise<{ text: string; target: ModelTarget }>;
  applySessionRules?: (policy: ReviewPolicyBundle, rules: string[]) => ReviewPolicyBundle;
  patch?: {
    source(session: ReviewSession, file: string): string;
    prepare(
      session: ReviewSession,
      file: string,
      replacement: string,
    ): Promise<{ baseHash: string; preview: string }>;
    apply(
      session: ReviewSession,
      proposal: PatchProposal,
      isolated: boolean,
    ): Promise<{ destination: string; backup: string }>;
    describe(session: ReviewSession, proposal: PatchProposal, isolated: boolean): string;
  };
  github?: {
    repository(): Promise<string>;
    capture(request: PullRequestRequest, exclusions: string[]): Promise<ReviewSnapshot>;
    head(request: {
      repository: string;
      number: number;
    }): Promise<{ headSha: string; baseSha: string; state: string }>;
    findPublication(publication: Publication): Promise<string | undefined>;
    publish(publication: Publication): Promise<string>;
  };
  writable?: boolean;
};
