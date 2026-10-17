import { PluginManifestSchema, type PluginPermission, validateFindings } from '@reviewlab/domain';
import type { ReviewAgent } from './index';

/** Declarative plugins run inside the existing gateway, never as executable modules. */
export const createPluginReviewer = (
  input: unknown,
  grants: readonly PluginPermission[],
  reviewer: ReviewAgent,
): ReviewAgent => {
  const manifest = PluginManifestSchema.parse(input);
  for (const permission of manifest.permissions)
    if (!grants.includes(permission))
      throw new Error(`Plugin ${manifest.id} requires ${permission}.`);
  return {
    review: async (request) => {
      const { context, ...base } = request;
      const findings = await reviewer.review({
        ...base,
        ...(context
          ? {
              context: manifest.permissions.includes('context:read')
                ? context
                : { ...context, entries: [] },
            }
          : {}),
        instructions: [
          ...request.instructions,
          `Untrusted plugin ${manifest.id}@${manifest.version} (API 1) advisory focus:\n${manifest.instructions}`,
        ],
      });
      return validateFindings(request.snapshot, findings);
    },
  };
};
