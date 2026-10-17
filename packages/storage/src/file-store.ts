import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  diffSections,
  ModelTargetSchema,
  type ReviewSession,
  type ReviewSnapshot,
  SessionSchema,
  SnapshotSchema,
  validateFindings,
  validateReviewProvenance,
  validateTarget,
} from '@hunkyard/domain';
import { stateDirectory } from './state-directory';

export type SessionStore = {
  save(session: ReviewSession): Promise<void>;
  get(id: string): Promise<ReviewSession | null>;
  list(): Promise<ReviewSession[]>;
};
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
const directory = async (path: string) => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Review storage directory must not be a symlink.');
};
const read = async (path: string): Promise<string> => {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 40 * 1024 * 1024)
    throw new Error('Unsafe or oversized review storage file.');
  return readFile(path, 'utf8');
};
const atomicWrite = async (path: string, data: string, immutable = false) => {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (immutable) await link(temp, path);
    else await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
};
export const validateSnapshot = (input: unknown): ReviewSnapshot => {
  const snapshot = SnapshotSchema.parse(input);
  if (createHash('sha256').update(snapshot.diff).digest('hex') !== snapshot.diffHash)
    throw new Error('Snapshot diff integrity check failed.');
  if (
    snapshot.pullRequest &&
    (snapshot.headSha !== snapshot.pullRequest.headSha ||
      snapshot.baseSha !== snapshot.pullRequest.mergeBaseSha ||
      snapshot.comparisonSha !== snapshot.pullRequest.baseSha ||
      snapshot.capture?.from !== snapshot.baseSha ||
      snapshot.capture.to !== snapshot.headSha ||
      snapshot.scope !== 'commit-range')
  )
    throw new Error('PR snapshot commit provenance disagrees.');
  let total = 0;
  const seen = new Set<string>();
  for (const source of snapshot.sources) {
    const bytes = Buffer.from(source.bytes, 'base64');
    if (bytes.toString('base64') !== source.bytes)
      throw new Error('Invalid retained source encoding.');
    const hash = createHash(source.oid.length === 40 ? 'sha1' : 'sha256')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    if (hash !== source.oid || seen.has(source.oid))
      throw new Error('Snapshot source integrity check failed.');
    seen.add(source.oid);
    total += bytes.length;
    let text: string | null = null;
    try {
      if (!bytes.includes(0)) text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      /* Retain binary bytes. */
    }
    if (text !== source.text) throw new Error('Retained text does not match source bytes.');
  }
  if (total > 8 * 1024 * 1024) throw new Error('Snapshot source exceeds retention limit.');
  const paths = snapshot.changes.map((change) => {
    for (const side of ['old', 'new'] as const) {
      const oid = side === 'old' ? change.oldOid : change.newOid;
      const mode = side === 'old' ? change.oldMode : change.newMode;
      const path = side === 'old' ? change.oldPath : change.newPath;
      if ((oid === null) !== (mode === null) || (oid === null) !== (path === null))
        throw new Error('Inconsistent snapshot file metadata.');
      if (
        oid &&
        mode !== '160000' &&
        !seen.has(oid) &&
        !snapshot.omissions?.some(
          (omission) => omission.path === (change.newPath ?? change.oldPath),
        )
      )
        throw new Error('Snapshot source object is missing.');
    }
    return change.newPath ?? change.oldPath;
  });
  if (snapshot.omissions) {
    const sections = diffSections(snapshot);
    for (const change of snapshot.changes) {
      const omitted = snapshot.omissions.some(
        (entry) => entry.path === (change.newPath ?? change.oldPath),
      );
      const included = sections.some(
        (section) => section.oldPath === change.oldPath && section.newPath === change.newPath,
      );
      if (omitted === included)
        throw new Error('Every changed file must have exactly one diff or omission record.');
    }
    if (snapshot.omissions.some((entry) => !snapshot.files.includes(entry.path)))
      throw new Error('Omission references an unknown changed file.');
  }
  if (JSON.stringify(paths) !== JSON.stringify(snapshot.files))
    throw new Error('Snapshot changed paths disagree.');
  return snapshot;
};

export const validateSessionIntegrity = (session: ReviewSession): void => {
  validateReviewProvenance(session);
  validateSnapshot(session.snapshot);
  validateFindings(session.snapshot, session.findings);
  const bundle = {
    ...(session.policy.plugin ? { plugin: session.policy.plugin } : {}),
    version: session.policy.version,
    instructions: session.policy.instructions,
    sources: session.policy.sources,
    exclusions: session.policy.exclusions,
    ...(session.policy.fileRules ? { fileRules: session.policy.fileRules } : {}),
    ...(session.policy.conflicts ? { conflicts: session.policy.conflicts } : {}),
    ...(session.policy.diagnostics ? { diagnostics: session.policy.diagnostics } : {}),
  };
  if (
    createHash('sha256').update(JSON.stringify(bundle)).digest('hex') !== session.policy.hash ||
    JSON.stringify(session.instructions) !== JSON.stringify(session.policy.instructions)
  )
    throw new Error('Policy provenance integrity check failed.');
  if (
    session.context &&
    (session.context.snapshotId !== session.snapshot.id ||
      session.context.policyHash !== session.policy.hash)
  )
    throw new Error('Context provenance does not match the originating review.');
  if (session.context?.semantic) {
    validateTarget(
      ModelTargetSchema.parse({
        ...session.context.semantic,
        privacy: 'local-only',
        cloudConsent: false,
        repository: session.target.repository,
      }),
    );
  }
  if (
    session.context?.entries?.some((entry) => entry.reason === 'semantic') &&
    !session.context.semantic
  )
    throw new Error('Semantic context is missing local retrieval provenance.');
  for (const entry of session.context?.entries ?? []) {
    if (
      entry.endLine < entry.startLine ||
      createHash('sha256').update(entry.text).digest('hex') !== entry.hash
    )
      throw new Error('Frozen context excerpt integrity check failed.');
  }
  if (
    session.context?.entries &&
    session.context.files.some((path) => !session.snapshot.files.includes(path))
  )
    throw new Error('Context review coverage references an unknown changed file.');
  if (
    session.findings.some(
      (finding) =>
        (finding.runId !== undefined && finding.runId !== session.runId) ||
        (finding.contextManifestId !== undefined &&
          finding.contextManifestId !== session.context?.id),
    )
  )
    throw new Error('Finding run/context provenance does not match the originating review.');
  if (
    session.findings.some(
      (finding) =>
        finding.snapshotId !== session.snapshot.id ||
        finding.policyHash !== session.policy.hash ||
        (finding.attributions
          ? finding.attributions.some(
              (attribution) =>
                !session.plan?.agents.some(
                  (route) =>
                    route.id === attribution.agent &&
                    JSON.stringify(route.target) === JSON.stringify(attribution.target),
                ),
            ) ||
            finding.model !== finding.attributions[0]?.target.model ||
            finding.provider !== finding.attributions[0]?.target.provider
          : finding.model !== session.target.model || finding.provider !== session.target.provider),
    )
  )
    throw new Error('Finding provenance does not match the originating review.');
};

export const createFileSessionStore = (root: string): SessionStore => {
  const prepare = async () => {
    const parent = await stateDirectory(root, 'sessions-v2');
    const dir = join(parent, 'sessions-v2');
    const snapshots = join(parent, 'snapshots-v2');
    await directory(parent);
    await directory(dir);
    await directory(snapshots);
    return { dir, snapshots };
  };
  const get = async (id: string): Promise<ReviewSession | null> => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { dir, snapshots } = await prepare();
    let content: string;
    try {
      content = await read(join(dir, `${id}.json`));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    const session = SessionSchema.parse(JSON.parse(content));
    if (session.id !== id) throw new Error('Session ID does not match its storage filename.');
    validateSessionIntegrity(session);
    let frozen: ReviewSnapshot;
    try {
      frozen = validateSnapshot(
        JSON.parse(await read(join(snapshots, `${session.snapshot.id}.json`))),
      );
    } catch (error) {
      if (missing(error))
        throw new Error('Immutable snapshot is missing; review history cannot be verified.');
      throw error;
    }
    if (JSON.stringify(frozen) !== JSON.stringify(session.snapshot))
      throw new Error('Persisted snapshot was modified.');
    return session;
  };
  return {
    get,
    save: async (input) => {
      const session = SessionSchema.parse(input);
      validateSessionIntegrity(session);
      const { dir, snapshots } = await prepare();
      const lock = join(dir, `${session.id}.lock`);
      try {
        await mkdir(lock);
      } catch {
        throw new Error('Session is locked by another writer; retry or inspect a stale lock.');
      }
      try {
        const current = await get(session.id);
        if ((current ? current.revision + 1 : 0) !== session.revision)
          throw new Error('Session revision conflict. Reload before changing it.');
        const snapshotFile = join(snapshots, `${session.snapshot.id}.json`);
        const data = JSON.stringify(session.snapshot);
        try {
          await atomicWrite(snapshotFile, data, true);
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
          if ((await read(snapshotFile)) !== data)
            throw new Error('An immutable snapshot cannot be replaced.');
        }
        if (
          current &&
          (current.target.repository !== session.target.repository ||
            JSON.stringify(current.target) !== JSON.stringify(session.target) ||
            JSON.stringify(current.policy) !== JSON.stringify(session.policy) ||
            current.snapshot.id !== session.snapshot.id)
        )
          throw new Error('Session provenance cannot be changed.');
        await atomicWrite(join(dir, `${session.id}.json`), JSON.stringify(session));
      } finally {
        await rm(lock, { recursive: true });
      }
    },
    list: async () => {
      const { dir, snapshots } = await prepare();
      const sessions = await Promise.all(
        (await readdir(dir))
          .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
          .map((name) => get(name.slice(0, -5))),
      );
      return sessions
        .filter((session): session is ReviewSession => session !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  };
};
