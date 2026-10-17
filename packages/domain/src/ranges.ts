import type { FindingDraft, ReviewSnapshot } from './index';

const decodePath = (header: string): string | null => {
  const value = header.replace(/\t$/, '');
  if (value === '/dev/null') return null;
  if (!value.startsWith('"')) return value.slice(2);
  const bytes: number[] = [];
  const quoted = value.slice(1, -1);
  for (let index = 0; index < quoted.length; index += 1) {
    const char = quoted[index];
    if (char === '\\') {
      const octal = quoted.slice(index + 1).match(/^[0-7]{3}/)?.[0];
      if (octal) {
        bytes.push(Number.parseInt(octal, 8));
        index += 3;
      } else {
        index += 1;
        const escape = quoted[index] ?? '';
        const escapes: Record<string, number> = {
          a: 7,
          b: 8,
          t: 9,
          n: 10,
          v: 11,
          f: 12,
          r: 13,
          '"': 34,
          '\\': 92,
        };
        const byte = escapes[escape];
        if (byte === undefined) throw new Error('Invalid quoted Git path.');
        bytes.push(byte);
      }
    } else if (char) bytes.push(...new TextEncoder().encode(char));
  }
  return new TextDecoder().decode(new Uint8Array(bytes)).slice(2);
};
const quotedGitPath = (prefix: string, path: string): string => {
  const bytes = new TextEncoder().encode(`${prefix}/${path}`);
  let escaped = false;
  const controls: Record<number, string> = {
    7: 'a',
    8: 'b',
    9: 't',
    10: 'n',
    11: 'v',
    12: 'f',
    13: 'r',
    34: '"',
    92: '\\',
  };
  const value = Array.from(bytes, (byte) => {
    const control = controls[byte];
    if (control) {
      escaped = true;
      return `\\${control}`;
    }
    if (byte < 32 || byte >= 127) {
      escaped = true;
      return `\\${byte.toString(8).padStart(3, '0')}`;
    }
    return String.fromCharCode(byte);
  }).join('');
  return escaped ? `"${value}"` : value;
};
export const diffSections = (snapshot: Pick<ReviewSnapshot, 'diff' | 'changes'>) =>
  snapshot.diff
    .split(/^diff --git /m)
    .slice(1)
    .map((body) => {
      const header = body.split('\n')[0];
      const change = snapshot.changes.find((entry) => {
        const oldPath = entry.oldPath ?? entry.newPath;
        const newPath = entry.newPath ?? entry.oldPath;
        return (
          oldPath &&
          newPath &&
          header === `${quotedGitPath('a', oldPath)} ${quotedGitPath('b', newPath)}`
        );
      });
      const oldHeader = body.match(/^--- (.+)$/m)?.[1];
      const newHeader = body.match(/^\+\+\+ (.+)$/m)?.[1];
      return {
        text: `diff --git ${body}`,
        oldPath: change ? change.oldPath : oldHeader ? decodePath(oldHeader) : null,
        newPath: change ? change.newPath : newHeader ? decodePath(newHeader) : null,
      };
    });
/** Portable root-relative globs: *, ** and ?; trailing / selects a subtree. */
export const matchesPath = (path: string, pattern: string): boolean => {
  const normalized = pattern.endsWith('/') ? `${pattern}**` : pattern;
  let expression = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === '*' && normalized[i + 1] === '*') {
      i += 1;
      if (normalized[i + 1] === '/') {
        expression += '(?:.*/)?';
        i += 1;
      } else expression += '.*';
    } else if (char === '*') expression += '[^/]*';
    else if (char === '?') expression += '[^/]';
    else expression += (char ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`).test(path);
};
export const excludedPath = (path: string | null, exclusions: readonly string[]): boolean =>
  path !== null && exclusions.some((entry) => matchesPath(path, entry));

export const changedLines = (snapshot: ReviewSnapshot): Map<string, Set<number>> => {
  const ranges = new Map<string, Set<number>>();
  for (const patch of diffSections(snapshot)) {
    const change = snapshot.changes.find(
      (entry) =>
        (patch.newPath !== null && entry.newPath === patch.newPath) ||
        (patch.oldPath !== null && entry.oldPath === patch.oldPath),
    );
    if (!change || change.binary) continue;
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    for (const line of patch.text.split('\n')) {
      const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (header) {
        oldLine = Number(header[1]);
        newLine = Number(header[2]);
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      const record = (side: 'old' | 'new', path: string | null, number: number) => {
        if (!path) return;
        const key = `${side}:${path}`;
        const set = ranges.get(key) ?? new Set<number>();
        set.add(number);
        ranges.set(key, set);
      };
      if (line.startsWith('+')) {
        record('new', patch.newPath, newLine);
        newLine += 1;
      } else if (line.startsWith('-')) {
        record('old', patch.oldPath, oldLine);
        oldLine += 1;
      } else if (line.startsWith(' ')) {
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return ranges;
};
export const validateFindings = (
  snapshot: ReviewSnapshot,
  findings: FindingDraft[],
): FindingDraft[] => {
  const ranges = changedLines(snapshot);
  for (const finding of findings) {
    if (!ranges.get(`${finding.side}:${finding.file}`)?.has(finding.line))
      throw new Error('Model output cites a file or line outside the frozen changed source.');
    const change = snapshot.changes.find(
      (entry) => (finding.side === 'old' ? entry.oldPath : entry.newPath) === finding.file,
    );
    const sourceOid = finding.side === 'old' ? change?.oldOid : change?.newOid;
    const source = snapshot.sources.find((entry) => entry.oid === sourceOid);
    if (!source?.text || finding.line > source.text.split('\n').length || change?.binary)
      throw new Error('Model output does not anchor to retained text source.');
    if (
      !finding.evidence.trim() ||
      !source.text.split('\n')[finding.line - 1]?.trim().includes(finding.evidence.trim())
    )
      throw new Error('Model evidence is not an exact excerpt of its frozen source line.');
  }
  return findings;
};

export const reviewRulePaths = (snapshot: ReviewSnapshot, files: string[]): string[] => [
  ...new Set(
    snapshot.changes
      .filter((change) => files.includes(change.newPath ?? change.oldPath ?? ''))
      .flatMap((change) => [change.oldPath, change.newPath])
      .filter((path): path is string => path !== null),
  ),
];
