import { diffSections, type ReviewSnapshot } from '@hunkyard/domain';

export type DiffLine = {
  text: string;
  /** `old:path:line` / `new:path:line`, matching finding anchors. */
  anchor?: string;
  kind: 'hunk' | 'addition' | 'deletion' | 'context' | 'meta';
  oldNo?: number;
  newNo?: number;
  file: string;
};

export const diffLines = (snapshot: ReviewSnapshot, path: string | null): DiffLine[] =>
  diffSections(snapshot)
    .filter((section) => !path || section.oldPath === path || section.newPath === path)
    .flatMap((section) => {
      const file = section.newPath ?? section.oldPath ?? '';
      let oldLine = 0;
      let newLine = 0;
      let hunk = false;
      return section.text.split('\n').map((text): DiffLine => {
        const header = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (header) {
          oldLine = Number(header[1]);
          newLine = Number(header[2]);
          hunk = true;
          return { text, kind: 'hunk', file };
        }
        if (hunk && text.startsWith('+')) {
          const newNo = newLine++;
          return { text, kind: 'addition', anchor: `new:${section.newPath}:${newNo}`, newNo, file };
        }
        if (hunk && text.startsWith('-')) {
          const oldNo = oldLine++;
          return { text, kind: 'deletion', anchor: `old:${section.oldPath}:${oldNo}`, oldNo, file };
        }
        if (hunk && text.startsWith(' ')) {
          const line: DiffLine = {
            text,
            kind: 'context',
            oldNo: oldLine++,
            newNo: newLine++,
            file,
          };
          return line;
        }
        return { text, kind: 'meta', file };
      });
    });

/** Lines added/removed per file, for card badges. */
export const diffStats = (snapshot: ReviewSnapshot) => {
  const stats = new Map<string, { added: number; removed: number }>();
  for (const line of diffLines(snapshot, null)) {
    const entry = stats.get(line.file) ?? { added: 0, removed: 0 };
    if (line.kind === 'addition') entry.added += 1;
    if (line.kind === 'deletion') entry.removed += 1;
    stats.set(line.file, entry);
  }
  return stats;
};
