import { UserConfigSchema } from '@reviewlab/domain';

/** Version 0 is the original unversioned config; v1 adds explicit consent metadata. */
export const migrateUserConfig = (input: unknown) => {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('User configuration must be an object.');
  const version = 'version' in input ? input.version : 0;
  if (version !== 0 && version !== 1)
    throw new Error('Unsupported user configuration version; use a compatible ReviewLab release.');
  const config = UserConfigSchema.parse({ ...input, version: 1 });
  // Never infer related-source consent when upgrading an older diff-only configuration.
  config.contextCloudConsent ??= {};
  return { config, fromVersion: version, toVersion: 1, changed: version === 0 };
};
