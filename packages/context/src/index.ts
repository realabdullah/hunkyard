export {
  configPath,
  loadReviewOptions,
  loadTarget,
  readJson,
  repositoryKey,
  updateConfig,
} from './config';
export { projectSettings, resolvePolicy } from './policy';
export { collectContext, scopedInstructions } from './retrieval';

import { resolvePolicy } from './policy';
export const resolveInstructions = async (root: string): Promise<string[]> =>
  (await resolvePolicy(root)).instructions;

export { migrateUserConfig } from './migrations';
export {
  loadAuthorizedProviderSecret,
  loadProviderSecret,
  providerSecretPath,
  saveProviderSecret,
} from './secrets';
export type { SemanticRetriever } from './semantic';
export { semanticRank } from './semantic';
export { withSharedPolicy } from './shared-policy';
