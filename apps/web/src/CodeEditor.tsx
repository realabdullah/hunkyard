import type { Finding, ReviewSnapshot } from '@reviewlab/domain';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { useEffect, useRef, useState } from 'react';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';

(self as typeof self & { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};
export const CodeEditor = ({
  snapshot,
  path,
  findings,
}: {
  snapshot: ReviewSnapshot;
  path: string | null;
  findings: Finding[];
}) => {
  const host = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(true);
  const change = snapshot.changes.find((entry) => entry.newPath === path || entry.oldPath === path);
  const original = snapshot.sources.find((entry) => entry.oid === change?.oldOid)?.text;
  const modified = snapshot.sources.find((entry) => entry.oid === change?.newOid)?.text;
  const markerKey = JSON.stringify(findings);
  useEffect(() => {
    if (!host.current || !change || change.binary) return;
    const before = monaco.editor.createModel(original ?? '', 'typescript');
    const after = monaco.editor.createModel(modified ?? '', 'typescript');
    const editor = monaco.editor.createDiffEditor(host.current, {
      theme: 'vs-dark',
      readOnly: true,
      originalEditable: false,
      renderSideBySide: split,
      automaticLayout: true,
      accessibilitySupport: 'on',
      ariaLabel: `Frozen diff editor for ${path}`,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      useInlineViewWhenSpaceIsLimited: true,
    });
    editor.setModel({ original: before, modified: after });
    const markers = (side: 'old' | 'new') =>
      findings
        .filter((finding) => finding.file === path && finding.side === side)
        .map((finding) => ({
          startLineNumber: finding.line,
          endLineNumber: finding.line,
          startColumn: 1,
          endColumn: 1000,
          message: `${finding.severity}: ${finding.title} (suggested)`,
          severity: monaco.MarkerSeverity.Warning,
        }));
    monaco.editor.setModelMarkers(before, 'reviewlab', markers('old'));
    monaco.editor.setModelMarkers(after, 'reviewlab', markers('new'));
    return () => {
      editor.dispose();
      before.dispose();
      after.dispose();
    };
  }, [snapshot.id, original, modified, path, split, markerKey]);
  return (
    <section aria-label="Frozen code editor">
      <h3>Frozen code editor</h3>
      <p>
        Read-only. Alt+F1 opens editor accessibility help. Tab enters the editor; Ctrl+M toggles Tab
        focus navigation.
      </p>
      <label>
        Diff layout
        <select
          value={split ? 'split' : 'unified'}
          onChange={(event) => setSplit(event.target.value === 'split')}
        >
          <option value="split">Split</option>
          <option value="unified">Unified</option>
        </select>
      </label>
      {!change || change.binary ? (
        <p>Select an included text file to view its code.</p>
      ) : (
        <div className="code-editor" ref={host} />
      )}
    </section>
  );
};
