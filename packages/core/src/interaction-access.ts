import type { Interaction, ReviewSession } from '@reviewlab/domain';
export type InteractionAccess = {
  serial: <T>(operation: () => Promise<T>) => Promise<T>;
  writable: () => void;
  read: (id: string) => Promise<Interaction>;
  save: (state: Interaction) => Promise<void>;
  check: (state: Interaction, revision: number) => void;
  run: (id: string, runId: string) => Promise<ReviewSession>;
};
