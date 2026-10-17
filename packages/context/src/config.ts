import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  isHostedProvider,
  ModelConfigSchema,
  type ModelTarget,
  ReviewOptionsSchema,
} from '@hunkyard/domain';
import { migrateUserConfig } from './migrations';

/** User config (and stored provider keys beside it). Pre-rename `reviewlab` locations still work. */
export const configPath = () => {
  const override = process.env.HUNKYARD_USER_CONFIG || process.env.REVIEWLAB_USER_CONFIG;
  if (override) return override;
  const current = join(homedir(), '.config', 'hunkyard');
  const legacy = join(homedir(), '.config', 'reviewlab');
  return join(!existsSync(current) && existsSync(legacy) ? legacy : current, 'config.json');
};
const isMissing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
export const readJson = async (path: string): Promise<unknown> => {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 64_000)
      throw new Error('Unsafe configuration file.');
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
};
export const repositoryKey = (root: string): string =>
  createHash('sha256').update(root).digest('hex');
const parseUser = (value: unknown) => migrateUserConfig(value).config;
export const assertOutsideRepo = async (root: string, location = configPath()): Promise<void> => {
  const canonicalRoot = await realpath(root);
  const path = resolve(location);
  let parent = dirname(path);
  let canonicalParent: string;
  for (;;) {
    try {
      canonicalParent = await realpath(parent);
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
  const canonicalPath = resolve(canonicalParent, relative(parent, path));
  for (const location of [path, canonicalPath]) {
    const local = relative(canonicalRoot, location);
    if (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`))
      throw new Error(
        'User configuration and provider secrets must be stored outside the reviewed repository.',
      );
  }
};
export const loadTarget = async (root: string): Promise<ModelTarget> => {
  await assertOutsideRepo(root);
  const config = parseUser(await readJson(configPath()));
  const approvedHostedOrigins =
    config.cloudDestinations?.[repositoryKey(root)] ??
    (config.cloudConsent[repositoryKey(root)] && config.contextCloudConsent?.[repositoryKey(root)]
      ? ['https://api.openai.com']
      : []);
  return {
    ...config.model,
    approvedHostedOrigins,
    repository: repositoryKey(root),
    cloudConsent:
      config.cloudConsent[repositoryKey(root)] === true &&
      config.contextCloudConsent?.[repositoryKey(root)] === true &&
      (!isHostedProvider(config.model.provider) ||
        approvedHostedOrigins.includes(new URL(config.model.endpoint).origin)),
  };
};
export const loadReviewOptions = async (root: string) => {
  await assertOutsideRepo(root);
  return ReviewOptionsSchema.parse(parseUser(await readJson(configPath())).review ?? {});
};
export const globalRules = async (): Promise<string[]> =>
  parseUser(await readJson(configPath())).rules;
export const updateConfig = async (
  root: string,
  update: { model?: unknown; allowCloud?: boolean; rules?: string[]; review?: unknown },
) => {
  await assertOutsideRepo(root);
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  try {
    await mkdir(lock);
  } catch {
    throw new Error('User configuration is locked by another writer.');
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const migration = migrateUserConfig(await readJson(configPath()));
    const config = migration.config;
    if (migration.changed) {
      try {
        await copyFile(path, `${path}.v0.bak`, constants.COPYFILE_EXCL);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    const key = repositoryKey(root);
    const previousOrigins =
      config.cloudDestinations?.[key] ??
      (config.cloudConsent[key] && config.contextCloudConsent?.[key]
        ? ['https://api.openai.com']
        : []);
    if (update.model) config.model = ModelConfigSchema.parse(update.model);
    if (update.review) config.review = ReviewOptionsSchema.parse(update.review);
    if (update.rules) config.rules = update.rules;
    if (update.allowCloud !== undefined) {
      config.cloudDestinations ??= {};
      const destinations = isHostedProvider(config.model.provider)
        ? [new URL(config.model.endpoint).origin]
        : [];
      config.cloudDestinations[key] = update.allowCloud
        ? [...new Set([...previousOrigins, ...destinations])]
        : [];
      config.cloudConsent[repositoryKey(root)] = update.allowCloud;
      config.contextCloudConsent ??= {};
      config.contextCloudConsent[repositoryKey(root)] = update.allowCloud;
    }
    await writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
    await rm(lock, { recursive: true });
  }
  return loadTarget(root);
};
