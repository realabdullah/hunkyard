import type { DomainEvent, Interaction, ReviewSession, ReviewSnapshot } from '@hunkyard/domain';
import type { SessionStore } from './file-store';

export type DurableEvent = DomainEvent;
export type DurableStore = SessionStore & {
  interaction(id: string): Promise<Interaction>;
  saveInteraction(state: Interaction, expected: number): Promise<void>;
  assertHistoryMigrated(): Promise<void>;
  runs(id: string): Promise<ReviewSession[]>;
  snapshots(id: string): Promise<ReviewSnapshot[]>;
  events(id: string, after?: number): Promise<DurableEvent[]>;
  progress(id: string, runId: string, message: string): Promise<void>;
  recover(): Promise<number>;
  acquireRuntime(): Promise<{ release(): Promise<void> }>;
  delete(id: string, revision: number): Promise<boolean>;
  prune(options: { before: string; keepLatest: number }): Promise<number>;
  usage(): Promise<{ sessions: number; runs: number; snapshots: number; bytes: number }>;
  export(id: string, redact?: boolean): Promise<unknown>;
};
