import { type SnapshotFileChange, SnapshotFileChangeSchema } from '@hunkyard/domain';

const isChangeStatus = (value: string | undefined): value is SnapshotFileChange['status'] =>
  value === 'A' || value === 'D' || value === 'M' || value === 'R' || value === 'T';

export const parseChanges = (raw: string, numstat: string): SnapshotFileChange[] => {
  const binaryPaths = new Set<string>();
  for (const record of numstat.split('\0').filter(Boolean)) {
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error('Malformed Git numstat record.');
    if (record.slice(0, firstTab) === '-' || record.slice(firstTab + 1, secondTab) === '-')
      binaryPaths.add(record.slice(secondTab + 1));
  }

  const records = raw.split('\0');
  const changes: SnapshotFileChange[] = [];
  for (let cursor = 0; cursor < records.length - 1; ) {
    const header = records[cursor++];
    const match = header?.match(/^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([ADMRT])\d*$/);
    const path = records[cursor++];
    if (!match || !path) throw new Error('Malformed Git raw diff record.');
    const [, oldMode, newMode, oldOid, newOid, status] = match;
    if (!oldMode || !newMode || !oldOid || !newOid || !isChangeStatus(status))
      throw new Error('Invalid Git change metadata.');
    const newPath = status === 'R' ? records[cursor++] : path;
    if (!newPath) throw new Error('Missing Git rename destination.');
    changes.push(
      SnapshotFileChangeSchema.parse({
        status,
        oldPath: status === 'A' ? null : path,
        newPath: status === 'D' ? null : newPath,
        oldMode: oldMode === '000000' ? null : oldMode,
        newMode: newMode === '000000' ? null : newMode,
        oldOid: oldMode === '000000' ? null : oldOid,
        newOid: newMode === '000000' ? null : newOid,
        binary: binaryPaths.has(path) || binaryPaths.has(newPath),
      }),
    );
  }
  return changes;
};
