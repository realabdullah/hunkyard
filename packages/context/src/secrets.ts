import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertCurrentAuthorization, ModelConfigSchema, type ModelTarget } from '@hunkyard/domain';
import { assertOutsideRepo, configPath, loadTarget } from './config';

export const providerSecretPath = () => join(dirname(configPath()), 'provider-secrets.json');
type Provider = ModelTarget['provider'];
const readSecrets = async (): Promise<Partial<Record<Provider, string>>> => {
  const path = providerSecretPath();
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64_000)
      throw new Error('Unsafe provider secret file.');
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      throw new Error('Provider secret file must have private permissions (0600).');
    const content = await readFile(path, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('Invalid provider secret file.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Invalid provider secret file.');
    const result: Partial<Record<Provider, string>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const provider = ModelConfigSchema.shape.provider.safeParse(key);
      if (!provider.success) throw new Error('Invalid provider secret file.');
      if (
        typeof value !== 'string' ||
        value.length < 1 ||
        value.length > 4096 ||
        /[\r\n]/.test(value)
      )
        throw new Error('Invalid provider secret entry.');
      result[provider.data] = value;
    }
    return result;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
};
export const loadProviderSecret = async (
  root: string,
  provider: Provider,
): Promise<string | undefined> => {
  await assertOutsideRepo(root, providerSecretPath());
  return (await readSecrets())[ModelConfigSchema.shape.provider.parse(provider)];
};
// Re-read consent for every hosted request, including repair and explicit capability probes.
export const loadAuthorizedProviderSecret = async (
  root: string,
  target: ModelTarget,
): Promise<string | undefined> => {
  const current = await loadTarget(root);
  if (target.repository !== current.repository)
    throw new Error('Model target belongs to another repository.');
  assertCurrentAuthorization(target, current);
  return loadProviderSecret(root, target.provider);
};
// Secrets are intentionally separate from public config/model targets and immutable run provenance.
export const saveProviderSecret = async (
  root: string,
  provider: Provider,
  secret: string | null,
): Promise<void> => {
  const validatedProvider = ModelConfigSchema.shape.provider.parse(provider);
  if (secret !== null && (!secret || secret.length > 4096 || /[\r\n]/.test(secret)))
    throw new Error('Provider secret must contain 1–4096 characters without line breaks.');
  const path = providerSecretPath();
  await assertOutsideRepo(root, path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertOutsideRepo(root, path);
  const lock = `${path}.lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error('Provider secrets are locked by another writer.');
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const secrets = await readSecrets();
    if (secret === null) delete secrets[validatedProvider];
    else secrets[validatedProvider] = secret;
    await writeFile(temp, JSON.stringify(secrets), { mode: 0o600, flag: 'wx' });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
    await rm(lock, { recursive: true });
  }
};
