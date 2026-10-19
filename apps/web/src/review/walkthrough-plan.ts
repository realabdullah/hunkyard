import type { ReviewSnapshot, SnapshotFileChange, Walkthrough } from '@hunkyard/domain';
import { diffLines, diffStats } from '../diff-lines';

export type Role = 'code' | 'test' | 'config' | 'docs' | 'generated';
export type Stop = {
  path: string;
  status: SnapshotFileChange['status'];
  role: Role;
  added: number;
  removed: number;
  /** Other changed files this one imports, and changed files that import it. */
  uses: string[];
  usedBy: string[];
};
export const roleTitles: Record<Role, string> = {
  code: 'Code',
  test: 'Tests',
  config: 'Config & build',
  docs: 'Docs',
  generated: 'Generated',
};
const roleOrder: Role[] = ['code', 'test', 'config', 'docs', 'generated'];

const roleOf = (path: string): Role => {
  const name = path.split('/').pop() ?? path;
  if (
    /(^|\/)(dist|build|out|coverage)\//.test(path) ||
    /^(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum)$/.test(
      name,
    ) ||
    /\.(min\.(js|css)|snap|map)$/.test(name)
  )
    return 'generated';
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || /(^|\/)(__tests__|tests?|e2e)\//.test(path))
    return 'test';
  if (/\.(mdx?|txt|rst|adoc)$/i.test(name) || /^(docs?)\//.test(path) || /^LICENSE/i.test(name))
    return 'docs';
  if (
    name.startsWith('.') ||
    path.startsWith('.github/') ||
    /^(package\.json|tsconfig.*\.json|Dockerfile|Makefile)$/.test(name) ||
    /\.config\.[cm]?[jt]s$/.test(name) ||
    /\.(ya?ml|toml|ini|json|lock)$/.test(name)
  )
    return 'config';
  return 'code';
};

const importPattern =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|@import\s+)['"]([^'"\n]+)['"]/g;
const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.css', '.scss'];

const resolve = (from: string, specifier: string, known: Set<string>) => {
  if (!specifier.startsWith('.')) return null;
  const parts = from.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  const base = parts.join('/');
  // TypeScript ESM imports name the emitted `.js` file; try the source extensions too.
  const stem = base.replace(/\.[cm]?jsx?$/, '');
  const candidates = [base, stem].flatMap((candidate) => [
    candidate,
    ...extensions.flatMap((extension) => [
      `${candidate}${extension}`,
      `${candidate}/index${extension}`,
    ]),
  ]);
  return candidates.find((path) => known.has(path)) ?? null;
};

/** The new-side text of each changed file, keyed by path; deleted and binary files have none. */
const textOf = (snapshot: ReviewSnapshot) => {
  const byOid = new Map(snapshot.sources.map((source) => [source.oid, source.text]));
  return (change: SnapshotFileChange) =>
    change.newOid && !change.binary ? (byOid.get(change.newOid) ?? null) : null;
};

/**
 * Orders a snapshot's files into a reading path: code first, each file before the changed files
 * that import it, so definitions are read before their uses; then tests, config, docs and
 * generated files. Files that import each other in a cycle keep path order.
 */
export const readingPath = (snapshot: ReviewSnapshot): Stop[] => {
  const stats = diffStats(snapshot);
  const text = textOf(snapshot);
  const changes = snapshot.changes.filter((change) => change.newPath ?? change.oldPath);
  const pathOf = (change: SnapshotFileChange) => (change.newPath ?? change.oldPath) as string;
  const known = new Set(changes.map(pathOf));
  const uses = new Map<string, Set<string>>();
  const usedBy = new Map<string, Set<string>>();
  for (const change of changes) {
    const path = pathOf(change);
    uses.set(path, new Set());
    usedBy.set(path, usedBy.get(path) ?? new Set());
    for (const match of (text(change) ?? '').matchAll(importPattern)) {
      const target = match[1] ? resolve(path, match[1], known) : null;
      if (!target || target === path) continue;
      uses.get(path)?.add(target);
      usedBy.set(target, (usedBy.get(target) ?? new Set()).add(path));
    }
  }
  const stops = changes.map(
    (change): Stop => ({
      path: pathOf(change),
      status: change.status,
      role: roleOf(pathOf(change)),
      added: stats.get(pathOf(change))?.added ?? 0,
      removed: stats.get(pathOf(change))?.removed ?? 0,
      uses: [...(uses.get(pathOf(change)) ?? [])].sort(),
      usedBy: [...(usedBy.get(pathOf(change)) ?? [])].sort(),
    }),
  );
  return roleOrder.flatMap((role) => {
    const group = stops
      .filter((stop) => stop.role === role)
      .sort((a, b) => a.path.localeCompare(b.path));
    const inGroup = new Set(group.map((stop) => stop.path));
    const ordered: Stop[] = [];
    const placed = new Set<string>();
    const visiting = new Set<string>();
    const byPath = new Map(group.map((stop) => [stop.path, stop]));
    const visit = (stop: Stop) => {
      if (placed.has(stop.path) || visiting.has(stop.path)) return;
      visiting.add(stop.path);
      for (const dependency of stop.uses) {
        const next = inGroup.has(dependency) ? byPath.get(dependency) : undefined;
        if (next) visit(next);
      }
      visiting.delete(stop.path);
      placed.add(stop.path);
      ordered.push(stop);
    };
    for (const stop of group) visit(stop);
    return ordered;
  });
};

export type Note = Walkthrough['notes'][number];

const lineText = (snapshot: ReviewSnapshot, note: Note) => {
  if (note.line === null) return null;
  const anchor = `${note.side}:${note.path}:${note.line}`;
  const found = diffLines(snapshot, note.path).find((line) => line.anchor === anchor);
  const code = found?.text.slice(1).trim();
  if (!code) return null;
  return code.length > 100 ? `${code.slice(0, 100)}…` : code;
};

/**
 * The message handed back to the coding agent. Notes are grouped by file in reading order, with
 * the exact line they point at, so the agent can act on them without the browser.
 */
export const buildHandoff = (
  snapshot: ReviewSnapshot,
  path: Stop[],
  notes: Note[],
  decision: 'approve' | 'request-changes',
  summary: string,
) => {
  const files = `${path.length} file${path.length === 1 ? '' : 's'}`;
  const intro = summary.trim();
  if (decision === 'approve')
    return [`I reviewed your changes (${files}) and approve them.`, intro]
      .filter(Boolean)
      .join('\n\n');
  const order = new Map(path.map((stop, index) => [stop.path, index]));
  const byFile = new Map<string, Note[]>();
  for (const note of [...notes].sort(
    (a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0) || (a.line ?? 0) - (b.line ?? 0),
  ))
    byFile.set(note.path, [...(byFile.get(note.path) ?? []), note]);
  const sections = [...byFile].map(([file, entries]) =>
    [
      `## ${file}`,
      ...entries.map((note) => {
        const where =
          note.line === null
            ? 'Whole file'
            : `Line ${note.line}${note.side === 'old' ? ' (removed)' : ''}`;
        const code = lineText(snapshot, note);
        const text = note.text.replace(/\n/g, '\n  ');
        return `- ${where}${code ? ` \`${code.replace(/`/g, "'")}\`` : ''}: ${text}`;
      }),
    ].join('\n'),
  );
  return [
    `I reviewed your changes (${files}) and need the following changes before I accept them.`,
    intro,
    ...sections,
    'Change only what these notes ask for. When you are done, list which notes you addressed and anything you could not.',
  ]
    .filter(Boolean)
    .join('\n\n');
};
