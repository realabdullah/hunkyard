import type { Finding, ReviewSnapshot } from '@hunkyard/domain';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import { diffStats } from './diff-lines';
import { dirName, fileName, severityMeta, sortFindings } from './lib/meta';
import { isDark, useTheme } from './lib/theme';
import { Icon } from './ui/Icon';
import { IconButton, Kbd, Pill, Segmented } from './ui/primitives';

(self as typeof self & { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

monaco.editor.defineTheme('hunkyard-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6f6f7a', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'b4a8de' },
    { token: 'string', foreground: '8ccca8' },
    { token: 'number', foreground: 'd4b77a' },
    { token: 'type', foreground: '82c2c4' },
  ],
  colors: {
    'editor.background': '#0f0f12',
    'editor.lineHighlightBackground': '#ffffff08',
    'editorLineNumber.foreground': '#4a4a55',
    'editorLineNumber.activeForeground': '#a4a4ad',
    'editorGutter.background': '#0f0f12',
    'diffEditor.insertedTextBackground': '#4ade961f',
    'diffEditor.removedTextBackground': '#ff5c7824',
    'diffEditor.insertedLineBackground': '#4ade9612',
    'diffEditor.removedLineBackground': '#ff5c7814',
    'diffEditor.diagonalFill': '#ffffff0a',
    'editorWarning.foreground': '#d4b77a',
    'scrollbarSlider.background': '#ffffff14',
    'diffEditorOverview.insertedForeground': '#6ec4968c',
    'diffEditorOverview.removedForeground': '#e5707f8c',
    'editorOverviewRuler.addedForeground': '#6ec4968c',
    'editorOverviewRuler.deletedForeground': '#e5707f8c',
    'editorOverviewRuler.border': '#00000000',
    'editor.selectionBackground': '#ffffff1f',
  },
});
monaco.editor.defineTheme('hunkyard-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '5b46a8' },
    { token: 'string', foreground: '17703f' },
    { token: 'type', foreground: '0d7476' },
  ],
  colors: {
    'editor.background': '#fbfbfa',
    'editorGutter.background': '#fbfbfa',
    'diffEditor.insertedTextBackground': '#17703f1f',
    'diffEditor.removedTextBackground': '#b0263f1f',
    'editorWarning.foreground': '#8a6a1f',
    'diffEditorOverview.insertedForeground': '#17703f80',
    'diffEditorOverview.removedForeground': '#b0263f80',
    'editorOverviewRuler.addedForeground': '#17703f80',
    'editorOverviewRuler.deletedForeground': '#b0263f80',
    'editorOverviewRuler.border': '#00000000',
    'editor.selectionBackground': '#17171b1f',
  },
});

/** Monaco needs literal colours for scrollbar marks; these match the severity tints. */
const rulerInk: Record<string, string> = {
  red: '#e3808d',
  orange: '#dd9a70',
  yellow: '#d4b77a',
  purple: '#ada2dc',
  blue: '#82c2c4',
  green: '#7cc69e',
  gray: '#9a9aa3',
};

/**
 * Full-height, read-only diff of one frozen file, opened as a focus mode over the board.
 * The findings rail jumps the modified side to each pinned line.
 */
export const CodeEditor = ({
  snapshot,
  path,
  findings,
  onClose,
  onFinding,
}: {
  snapshot: ReviewSnapshot;
  path: string;
  findings: Finding[];
  onClose: () => void;
  onFinding?: (finding: Finding) => void;
}) => {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [split, setSplit] = useState(true);
  const { dark } = useTheme();
  useEffect(() => monaco.editor.setTheme(dark ? 'hunkyard-dark' : 'hunkyard-light'), [dark]);
  const change = snapshot.changes.find((entry) => entry.newPath === path || entry.oldPath === path);
  const original = snapshot.sources.find((entry) => entry.oid === change?.oldOid)?.text;
  const modified = snapshot.sources.find((entry) => entry.oid === change?.newOid)?.text;
  const own = sortFindings(findings.filter((finding) => finding.file === path));
  const stat = diffStats(snapshot).get(path) ?? { added: 0, removed: 0 };
  const markerKey = JSON.stringify(own.map((finding) => [finding.id, finding.line, finding.side]));

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', escape, { capture: true });
    return () => window.removeEventListener('keydown', escape, { capture: true });
  }, [onClose]);

  useEffect(() => {
    if (!host.current || !change || change.binary) return;
    const before = monaco.editor.createModel(original ?? '', 'typescript');
    const after = monaco.editor.createModel(modified ?? '', 'typescript');
    const editor = monaco.editor.createDiffEditor(host.current, {
      theme: isDark() ? 'hunkyard-dark' : 'hunkyard-light',
      readOnly: true,
      originalEditable: false,
      renderSideBySide: split,
      automaticLayout: true,
      accessibilitySupport: 'on',
      ariaLabel: `Frozen diff editor for ${path}`,
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 21,
      fontFamily: 'SF Mono, JetBrains Mono, ui-monospace, Menlo, monospace',
      scrollBeyondLastLine: false,
      renderOverviewRuler: true,
      glyphMargin: true,
      padding: { top: 12 },
      useInlineViewWhenSpaceIsLimited: false,
    });
    editor.setModel({ original: before, modified: after });
    editorRef.current = editor;
    const findingsOn = (side: 'old' | 'new') => own.filter((finding) => finding.side === side);
    const markers = (side: 'old' | 'new') =>
      findingsOn(side).map((finding) => ({
        startLineNumber: finding.line,
        endLineNumber: finding.line,
        startColumn: 1,
        endColumn: 1000,
        message: `${severityMeta[finding.severity].label}: ${finding.title} (suggested)`,
        severity: monaco.MarkerSeverity.Warning,
      }));
    monaco.editor.setModelMarkers(before, 'hunkyard', markers('old'));
    monaco.editor.setModelMarkers(after, 'hunkyard', markers('new'));
    const decorate = (target: monaco.editor.ICodeEditor, side: 'old' | 'new') =>
      target.createDecorationsCollection(
        findingsOn(side).map((finding) => ({
          range: new monaco.Range(finding.line, 1, finding.line, 1),
          options: {
            isWholeLine: true,
            className: `rl-line sev-${severityMeta[finding.severity].tint}`,
            glyphMarginClassName: `rl-glyph sev-${severityMeta[finding.severity].tint}`,
            glyphMarginHoverMessage: { value: `**${finding.title}**` },
            overviewRuler: {
              color: rulerInk[severityMeta[finding.severity].tint],
              position: monaco.editor.OverviewRulerLane.Full,
            },
          },
        })),
      );
    decorate(editor.getOriginalEditor(), 'old');
    decorate(editor.getModifiedEditor(), 'new');
    const first = own[0];
    if (first) {
      const target = first.side === 'old' ? editor.getOriginalEditor() : editor.getModifiedEditor();
      setTimeout(() => target.revealLineInCenter(first.line), 60);
    }
    return () => {
      editorRef.current = null;
      editor.dispose();
      before.dispose();
      after.dispose();
    };
  }, [snapshot.id, original, modified, path, split, markerKey]);

  const reveal = (finding: Finding) => {
    const editor = editorRef.current;
    if (!editor) return;
    const target = finding.side === 'old' ? editor.getOriginalEditor() : editor.getModifiedEditor();
    target.revealLineInCenter(finding.line);
    target.setPosition({ lineNumber: finding.line, column: 1 });
    target.focus();
  };

  return createPortal(
    <div className="code-focus" role="dialog" aria-modal="true" aria-label={`Code: ${path}`}>
      <div className="code-focus-sheet">
        <header className="code-focus-head">
          <span className={`file-status st-${change?.status ?? 'M'}`}>{change?.status ?? 'M'}</span>
          <span className="code-focus-path">
            <strong>{fileName(path)}</strong>
            <small>{dirName(path) || './'}</small>
          </span>
          <span className="churn">
            <span className="add">+{stat.added}</span>
            <span className="del">−{stat.removed}</span>
          </span>
          <span className="code-focus-spacer" />
          <span className="code-focus-note">
            Read-only · <Kbd>Alt</Kbd>
            <Kbd>F1</Kbd> editor help
          </span>
          <Segmented
            label="Diff layout"
            value={split ? 'split' : 'unified'}
            onChange={(value) => setSplit(value === 'split')}
            options={[
              { id: 'split', label: 'Split' },
              { id: 'unified', label: 'Unified' },
            ]}
          />
          <IconButton icon="close" label="Close editor (Esc)" onClick={onClose} autoFocus />
        </header>
        <div className="code-focus-body">
          {!change || change.binary ? (
            <p className="code-focus-empty">This file has no text diff to show.</p>
          ) : (
            <div className="code-editor" ref={host} />
          )}
          <aside className="code-rail" aria-label="Findings in this file">
            <div className="kicker">Findings · {own.length}</div>
            {own.length === 0 && <p className="muted small">No findings in this file.</p>}
            {own.map((finding) => (
              <div key={finding.id} className="rail-item">
                <button type="button" className="rail-jump" onClick={() => reveal(finding)}>
                  <Pill tint={severityMeta[finding.severity].tint} dot>
                    L{finding.line}
                  </Pill>
                  <span>{finding.title}</span>
                </button>
                {onFinding && (
                  <button type="button" className="link small" onClick={() => onFinding(finding)}>
                    Open finding <Icon name="arrowRight" size={12} />
                  </button>
                )}
              </div>
            ))}
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  );
};
