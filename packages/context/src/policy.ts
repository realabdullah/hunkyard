import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
  matchesPath,
  ProjectConfigSchema,
  type ReviewPolicyBundle,
  STATE_DIRECTORIES,
  STATE_DIRECTORY,
} from '@hunkyard/domain';
import { globalRules, readJson } from './config';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const absent = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
/** First existing `<state folder>/<name>`, preferring `.hunkyard` over a pre-rename `.reviewlab`. */
const stateFile = async (root: string, name: string) => {
  for (const directory of STATE_DIRECTORIES) {
    try {
      await lstat(join(root, directory, name));
      return `${directory}/${name}`;
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }
  return `${STATE_DIRECTORY}/${name}`;
};
export const projectSettings = async (root: string) => {
  const location = join(root, await stateFile(root, 'config.json'));
  try {
    if (
      (await lstat(location)).isSymbolicLink() ||
      relative(await realpath(root), await realpath(location)).startsWith('..')
    )
      throw new Error('Project config escapes repository root.');
  } catch (error) {
    if (!absent(error)) throw error;
  }
  const result = ProjectConfigSchema.safeParse(await readJson(location));
  if (!result.success)
    throw new Error(
      'Project config accepts only rules and exclude, instructionSources, instructionOrder and contextBytes; privacy belongs in user config.',
    );
  return result.data;
};
const instructionFile = async (root: string, file: string): Promise<string | null> => {
  try {
    const path = join(root, file);
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      relative(await realpath(root), await realpath(path)).startsWith('..') ||
      stat.size > 1_000_000
    )
      throw new Error('Unsafe or oversized instruction file.');
    return await readFile(path, 'utf8');
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
};
const cursorFiles = async (root: string): Promise<string[]> => {
  const found: string[] = [];
  const visit = async (directory: string) => {
    let names: string[];
    try {
      names = (await readdir(join(root, directory))).sort();
    } catch (error) {
      if (absent(error)) return;
      throw error;
    }
    for (const name of names) {
      const path = `${directory}/${name}`;
      const stat = await lstat(join(root, path));
      if (stat.isSymbolicLink()) throw new Error('Symlinked Cursor rule source refused.');
      if (stat.isDirectory()) await visit(path);
      else if (name.endsWith('.mdc') || name.endsWith('.md')) found.push(path);
      if (found.length > 100)
        throw new Error('More than 100 Cursor rules. Disable this adapter or narrow the rules.');
    }
  };
  // Check the source directory itself too, before entering it.
  for (const path of ['.cursor', '.cursor/rules']) {
    try {
      if ((await lstat(join(root, path))).isSymbolicLink())
        throw new Error('Symlinked Cursor directory refused.');
    } catch (error) {
      if (absent(error)) return [];
      throw error;
    }
  }
  await visit('.cursor/rules');
  return found;
};
const parseCursor = (
  content: string,
): { text: string; patterns: string[]; diagnostic?: string } => {
  const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!front)
    return {
      text: content,
      patterns: [],
      diagnostic: 'No frontmatter: manually invoked rule omitted',
    };
  const metadata = front[1] ?? '';
  const always = /^alwaysApply:\s*true\s*$/m.test(metadata);
  const globs = metadata.match(/^globs:\s*(.*)$/m)?.[1]?.trim() ?? '';
  const patterns = globs
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((glob) => glob.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return {
    text: content.slice(front[0].length),
    patterns: always ? ['**'] : patterns,
    ...(!always && !patterns.length
      ? { diagnostic: 'Agent-requested/manual rule has no automatic applicability; omitted' }
      : {}),
  };
};
export const resolvePolicy = async (
  root: string,
  changedPaths: string[] = [],
): Promise<ReviewPolicyBundle> => {
  const settings = await projectSettings(root);
  const enabled = new Set(
    settings.instructionSources ?? [
      'agents',
      'claude',
      'copilot',
      'cursor',
      'pr-agent',
      'hunkyard',
    ],
  );
  const candidates: { path: string; format: string; patterns: string[] }[] = [];
  const directories = new Set(['']);
  for (const path of changedPaths) {
    let parent = dirname(path);
    while (parent !== '.') {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  for (const directory of [...directories].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b, 'en'),
  )) {
    for (const [format, name] of [
      ['agents', 'AGENTS.md'],
      ['claude', 'CLAUDE.md'],
    ] as const) {
      if (enabled.has(format))
        candidates.push({
          path: directory ? `${directory}/${name}` : name,
          format,
          patterns: [directory ? `${directory}/**` : '**'],
        });
    }
  }
  if (enabled.has('copilot'))
    candidates.push({
      path: '.github/copilot-instructions.md',
      format: 'copilot',
      patterns: ['**'],
    });
  if (enabled.has('hunkyard') || enabled.has('reviewlab'))
    candidates.push({
      path: await stateFile(root, 'review.md'),
      format: 'hunkyard',
      patterns: ['**'],
    });
  if (enabled.has('pr-agent'))
    candidates.push({ path: '.pr_agent.toml', format: 'pr-agent', patterns: ['**'] });
  if (enabled.has('cursor'))
    for (const path of await cursorFiles(root))
      candidates.push({ path, format: 'cursor', patterns: [] });
  const sources: ReviewPolicyBundle['sources'] = [];
  const diagnostics: string[] = [];
  for (const candidate of candidates) {
    const content = await instructionFile(root, candidate.path);
    if (content === null || !content) continue;
    let text = content;
    let patterns = candidate.patterns;
    if (candidate.format === 'cursor') {
      const parsed = parseCursor(content);
      patterns = parsed.patterns;
      text = parsed.text;
      if (parsed.diagnostic) diagnostics.push(`${candidate.path}: ${parsed.diagnostic}`);
    }
    if (candidate.format === 'pr-agent') {
      // Deliberately narrow TOML adapter; arbitrary Qodo settings are not Hunkyard permissions.
      const section = content.match(/\[pr_reviewer\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? '';
      text =
        section.match(/extra_instructions\s*=\s*"""([\s\S]*?)"""/)?.[1] ??
        section.match(/extra_instructions\s*=\s*"([^"\r\n]*)"/)?.[1] ??
        '';
      diagnostics.push(
        `${candidate.path}: only pr_reviewer.extra_instructions is supported; other TOML settings are not applied`,
      );
      if (!text) patterns = [];
    }
    sources.push({
      path: candidate.path,
      hash: hash(content),
      truncated: Buffer.byteLength(text) > 12000,
      format: candidate.format,
      patterns,
      content: new TextDecoder().decode(Buffer.from(text).subarray(0, 12000)),
    });
  }
  const rank = (path: string) => settings.instructionOrder.indexOf(path);
  sources.sort((a, b) => {
    const left = rank(a.path);
    const right = rank(b.path);
    if (left >= 0 || right >= 0) return (left < 0 ? -1 : left) - (right < 0 ? -1 : right);
    const depth = (path: string) =>
      /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(path) ? path.split('/').length - 1 : 0;
    return depth(a.path) - depth(b.path); // Root adapters first; nested rules override them.
  });
  const instructions = [
    ...sources
      .filter((source) => source.patterns?.includes('**') && source.content)
      .map((source) => `Repository advisory source ${source.path}:\n${source.content}`),
    ...(settings.rules.length ? [`Project advisory rules: ${settings.rules.join('\n')}`] : []),
    ...(await globalRules()).map((rule) => `User rule: ${rule}`),
  ];
  if (Buffer.byteLength(instructions.join('\n')) > 48000)
    throw new Error('Effective rules exceed the 48 KB limit.');
  const fileRules = [...new Set(changedPaths)].sort().map((path) => ({
    path,
    sourcePaths: sources
      .filter(
        (source) =>
          source.patterns?.some((pattern) => matchesPath(path, pattern)) && source.content,
      )
      .map((source) => source.path),
  }));
  const conflicts = fileRules
    .filter((rule) => rule.sourcePaths.length > 1)
    .map((rule) => ({
      path: rule.path,
      sources: rule.sourcePaths,
      resolution:
        'Overlapping advisory sources; later source takes precedence, then project rules, then user rules. instructionOrder explicitly overrides source order. Prose contradictions require owner inspection.',
    }));
  const bundle = {
    version: 1 as const,
    instructions,
    sources,
    exclusions: settings.exclude,
    fileRules,
    conflicts,
    diagnostics,
  };
  return { ...bundle, hash: hash(JSON.stringify(bundle)) };
};
