import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import {
  type ContextManifest,
  changedLines,
  diffSections,
  excludedPath,
  type ModelTarget,
  type ReviewPolicyBundle,
  type ReviewSnapshot,
  redactSecrets,
  reviewRulePaths,
} from '@reviewlab/domain';

import { type SemanticRetriever, semanticRank } from './semantic';

export type ContextReader = {
  entries: { path: string; oid: string; mode: string }[];
  read: (oid: string) => Promise<string | null>;
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const scopedInstructions = (policy: ReviewPolicyBundle, files: string[]): string[] => {
  const global = policy.instructions.filter(
    (text) => !text.startsWith('Repository advisory source '),
  );
  const scoped = files.map((path) => {
    const refs = policy.fileRules?.find((rule) => rule.path === path)?.sourcePaths ?? [];
    return `Advisory rules applying only to ${JSON.stringify(path)} (later takes precedence):\n${refs
      .map((ref) => {
        const source = policy.sources.find((entry) => entry.path === ref);
        return `${ref}:\n${source?.content ?? ''}`;
      })
      .join('\n')}`;
  });
  return policy.fileRules ? [...scoped, ...global] : policy.instructions;
};
export const collectContext = async (
  snapshot: ReviewSnapshot,
  policy: ReviewPolicyBundle,
  target: ModelTarget,
  reader: ContextReader,
  byteBudget = 24000,
  semantic?: SemanticRetriever,
): Promise<ContextManifest> => {
  const maxInputTokens = Math.max(
    1,
    Math.min(target.contextWindow ?? 128000, target.maxReviewTokens ?? 400000) - target.maxTokens,
  );
  const omissions: NonNullable<ContextManifest['omissions']> = [...(snapshot.omissions ?? [])];
  const files: string[] = [];
  let promptBytes =
    4096 + Buffer.byteLength(redactSecrets(scopedInstructions(policy, []).join('\n\n'))); // System/message framing + bounded repair reserve; actual transport rechecks.
  for (const patch of diffSections(snapshot)) {
    const path = patch.newPath ?? patch.oldPath;
    if (
      !path ||
      excludedPath(patch.oldPath, policy.exclusions) ||
      excludedPath(patch.newPath, policy.exclusions)
    ) {
      if (path) omissions.push({ path, reason: 'Explicit project exclusion' });
      continue;
    }
    const instructions = scopedInstructions(policy, reviewRulePaths(snapshot, [...files, path]));
    const required =
      Buffer.byteLength(redactSecrets(patch.text)) +
      Buffer.byteLength(redactSecrets(instructions.join('\n\n')));
    const previousRules = Buffer.byteLength(
      redactSecrets(scopedInstructions(policy, reviewRulePaths(snapshot, files)).join('\n\n')),
    );
    if (promptBytes + required - previousRules > maxInputTokens)
      omissions.push({ path, reason: 'Reviewer input budget: whole file diff omitted' });
    else {
      files.push(path);
      promptBytes += required - previousRules;
    }
  }
  const entries: NonNullable<ContextManifest['entries']> = [];
  let usedBytes = 0;
  const excludedChanges = snapshot.changes.filter(
    (change) =>
      excludedPath(change.oldPath, policy.exclusions) ||
      excludedPath(change.newPath, policy.exclusions),
  );
  const excludedFiles = excludedChanges.map((change) => change.newPath ?? change.oldPath ?? '');
  const excludedAliases = new Set(
    excludedChanges.flatMap((change) => [change.oldPath, change.newPath]),
  );
  const available = reader.entries.filter(
    (entry) =>
      !excludedPath(entry.path, policy.exclusions) &&
      !excludedAliases.has(entry.path) &&
      entry.mode !== '120000' &&
      entry.mode !== '160000' &&
      !entry.path.startsWith('.reviewlab/') &&
      !/(^|\/)(node_modules|vendor|dist|build)\//.test(entry.path),
  );
  const byPath = new Map(available.map((entry) => [entry.path, entry]));
  const candidates = new Map<string, NonNullable<ContextManifest['entries']>[number]['reason']>();
  const symbols = new Set<string>();
  for (const path of files) {
    candidates.set(path, 'surrounding');
    const change = snapshot.changes.find((entry) => (entry.newPath ?? entry.oldPath) === path);
    const source =
      snapshot.sources.find((entry) => entry.oid === (change?.newOid ?? change?.oldOid))?.text ??
      '';
    for (const match of source.matchAll(
      /(?:from\s*|import\s*|require\s*\()\s*['"](\.[^'"]+)['"]/g,
    )) {
      const relative = posix.normalize(posix.join(posix.dirname(path), match[1] ?? ''));
      if (relative.startsWith('../')) continue;
      for (const extension of [
        '',
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '/index.ts',
        '/index.tsx',
        '/index.js',
      ]) {
        if (byPath.has(relative + extension)) {
          candidates.set(relative + extension, 'import');
          break;
        }
      }
    }
    for (const match of source.matchAll(
      /\b(?:function|class|interface|type|const)\s+([A-Za-z_$][\w$]*)/g,
    ))
      if (match[1] && symbols.size < 30) symbols.add(match[1]);
    const stem = posix.basename(path).replace(/\.[^.]+$/, '');
    for (const entry of available)
      if (
        new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\.(?:test|spec)\.[jt]sx?$`).test(
          posix.basename(entry.path),
        )
      )
        candidates.set(entry.path, 'test');
  }
  // Bounded deterministic symbol/reference search; no embeddings, commands or live file reads.
  let scannedBytes = 0;
  const texts = new Map<string, string>();
  const scan = (files.length ? available : [])
    .filter((entry) => /\.[jt]sx?$/.test(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  let scanStopped = false;
  for (const entry of scan.slice(0, 200)) {
    if (scannedBytes >= 500000) {
      scanStopped = true;
      break;
    }
    const text = await reader.read(entry.oid);
    if (text === null) continue;
    scannedBytes += Buffer.byteLength(text);
    texts.set(entry.oid, text);
    if (files.includes(entry.path)) continue;
    const matches = [...symbols].filter((symbol) =>
      new RegExp(`\\b${symbol.replace(/\$/g, '\\$')}\\b`).test(text),
    );
    if (matches.length && !candidates.has(entry.path))
      candidates.set(
        entry.path,
        matches.some((symbol) =>
          new RegExp(
            `\\b(?:function|class|interface|type|const)\\s+${symbol.replace(/\$/g, '\\$')}\\b`,
          ).test(text),
        )
          ? 'symbol'
          : 'reference',
      );
  }
  if (scan.length > 200 || scanStopped)
    for (const entry of scan.filter((entry) => !texts.has(entry.oid)))
      omissions.push({ path: entry.path, reason: 'Reference search budget (200 files / 500 KB)' });
  let semanticCandidates = 0;
  if (semantic && files.length) {
    const inputs = scan
      .filter((entry) => !files.includes(entry.path) && texts.has(entry.oid))
      .map((entry) => ({
        path: entry.path,
        text: redactSecrets((texts.get(entry.oid) ?? '').split('\n').slice(0, 80).join('\n')).slice(
          0,
          3000,
        ),
      }))
      .filter((entry) => entry.text.trim());
    semanticCandidates = inputs.length;
    const query = redactSecrets(
      diffSections(snapshot)
        .filter((patch) => files.includes(patch.newPath ?? patch.oldPath ?? ''))
        .map((patch) => patch.text)
        .join('\n'),
    ).slice(0, 3000);
    for (const path of await semanticRank(query, inputs, semantic))
      if (!candidates.has(path)) candidates.set(path, 'semantic');
  }
  const ranges = changedLines(snapshot);
  for (const [path, reason] of candidates) {
    const change = snapshot.changes.find((entry) => (entry.newPath ?? entry.oldPath) === path);
    const source = snapshot.sources.find(
      (entry) => entry.oid === (change?.newOid ?? change?.oldOid),
    );
    const record = byPath.get(path);
    const oid = source?.oid ?? record?.oid;
    if (!oid) {
      omissions.push({ path, reason: 'Context source unavailable in frozen tree' });
      continue;
    }
    const text = source?.text ?? texts.get(oid) ?? (await reader.read(oid));
    if (text === null || /^version https:\/\/git-lfs.github.com\/spec\/v1/.test(text)) {
      omissions.push({ path, reason: 'Binary, LFS or oversized context source' });
      continue;
    }
    const lines = text.split('\n');
    const anchors = ranges.get(`${change?.newPath ? 'new' : 'old'}:${path}`);
    const first =
      reason === 'surrounding' ? Math.max(0, (anchors?.values().next().value ?? 1) - 11) : 0;
    const end = Math.min(lines.length, first + 80);
    const excerpt = redactSecrets(lines.slice(first, end).join('\n'));
    const bytes = Buffer.byteLength(excerpt) + Buffer.byteLength(path) + 200;
    if (usedBytes + bytes > byteBudget || promptBytes + bytes > maxInputTokens) {
      omissions.push({ path, reason: 'Surrounding/symbol/test context budget' });
      continue;
    }
    entries.push({
      path,
      oid,
      reason,
      startLine: first + 1,
      endLine: end,
      text: excerpt,
      hash: hash(excerpt),
    });
    usedBytes += bytes;
    promptBytes += bytes;
    if (first > 0 || end < lines.length)
      omissions.push({
        path,
        reason: `Context excerpt lines ${first + 1}–${end}; remaining lines omitted`,
      });
  }
  return {
    id: randomUUID(),
    snapshotId: snapshot.id,
    policyHash: policy.hash,
    promptVersion: 'correctness-v1',
    files,
    excludedFiles,
    redacted: true,
    maxInputTokens,
    createdAt: new Date().toISOString(),
    entries,
    omissions,
    usedBytes,
    ...(semantic ? { semantic: { ...semantic.provenance, candidates: semanticCandidates } } : {}),
  };
};
