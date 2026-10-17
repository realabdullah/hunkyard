import { ReviewPlanSchema, type ReviewSession, SessionSchema } from '@hunkyard/domain';
import * as vscode from 'vscode';
import { assertExtensionAccess, frozenFindingSource, runCli, trustedExecutable } from './bridge';

export const activate = (context: vscode.ExtensionContext) => {
  const output = vscode.window.createOutputChannel('Hunkyard');
  const changed = new vscode.EventEmitter<void>();
  const lifecycle = new AbortController();
  let session: ReviewSession | undefined;
  let running = false;
  const documents = new Map<string, string>();
  const invoke = async (review: boolean) => {
    if (running) {
      void vscode.window.showInformationMessage('A Hunkyard command is already running.');
      return;
    }
    try {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const folder =
        folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
      if (!folder) return;
      assertExtensionAccess(vscode.workspace.isTrusted, folder.uri.scheme);
      const configured = vscode.workspace
        .getConfiguration('hunkyard')
        .inspect<string>('executable');
      const executable = trustedExecutable(configured?.globalValue);
      const node = trustedExecutable(
        vscode.workspace.getConfiguration('hunkyard').inspect<string>('nodeExecutable')
          ?.globalValue,
        'node',
      );
      running = true;
      if (review) {
        const config = await runCli(
          executable,
          folder.uri.fsPath,
          ['plan'],
          lifecycle.signal,
          node,
        );
        if (
          !config ||
          typeof config !== 'object' ||
          !('plan' in config) ||
          !('fingerprint' in config) ||
          typeof config.fingerprint !== 'string'
        )
          throw new Error('Invalid CLI target configuration.');
        const plan = ReviewPlanSchema.parse(config.plan);
        const destinations = plan.agents
          .map(
            (route) =>
              `${route.id}: ${route.target.provider}/${route.target.model} at ${route.target.endpoint} (${route.target.privacy})`,
          )
          .join('; ');
        const consent = await vscode.window.showWarningMessage(
          `Review staged Git changes in ${folder.uri.fsPath}? Source, rules and related frozen context go to ${destinations}. Uses existing CLI consent; no code edits or publication.`,
          { modal: true },
          'Review staged changes',
        );
        if (consent !== 'Review staged changes') return;
        assertExtensionAccess(vscode.workspace.isTrusted, folder.uri.scheme);
        session = SessionSchema.parse(
          await runCli(
            executable,
            folder.uri.fsPath,
            ['review', '--staged', '--expected-plan', config.fingerprint],
            lifecycle.signal,
            node,
          ),
        );
      } else {
        const consent = await vscode.window.showInformationMessage(
          'Read retained review source and findings from this workspace locally? Nothing is uploaded.',
          { modal: true },
          'Read history',
        );
        if (consent !== 'Read history') return;
        const raw = await runCli(
          executable,
          folder.uri.fsPath,
          ['sessions'],
          lifecycle.signal,
          node,
        );
        if (!Array.isArray(raw)) throw new Error('Invalid history response.');
        const sessions = raw.map((entry: unknown) => SessionSchema.parse(entry));
        const selected = await vscode.window.showQuickPick(
          sessions.map((entry) => ({
            label: `${entry.status} · ${entry.findings.length} findings`,
            description: entry.id,
            session: entry,
          })),
        );
        if (!selected) return;
        session = selected.session;
      }
      changed.fire();
      output.appendLine(
        `${session.status}: ${session.findings.length} findings. Run ${session.runId ?? session.id}. Sources are frozen; current editor lines may differ.`,
      );
      await vscode.commands.executeCommand('hunkyard.findings.focus');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Hunkyard failed.';
      output.appendLine(message);
      void vscode.window.showErrorMessage(message);
    } finally {
      running = false;
    }
  };
  const tree: vscode.TreeDataProvider<string> = {
    onDidChangeTreeData: changed.event,
    getChildren: () => session?.findings.map((entry) => entry.id) ?? [],
    getTreeItem: (id) => {
      const finding = session?.findings.find((entry) => entry.id === id);
      const item = new vscode.TreeItem(finding ? `${finding.severity}: ${finding.title}` : id);
      item.description = finding ? `${finding.file}:${finding.line} (${finding.side}, frozen)` : '';
      item.tooltip = finding
        ? `${finding.explanation}\nEvidence: ${finding.evidence}\nRecommendation: ${finding.recommendation}`
        : '';
      item.command = {
        command: 'hunkyard.openFinding',
        title: 'Open frozen source',
        arguments: [id],
      };
      return item;
    },
  };
  context.subscriptions.push(
    {
      dispose: () => {
        lifecycle.abort();
        documents.clear();
      },
    },
    output,
    changed,
    vscode.window.registerTreeDataProvider('hunkyard.findings', tree),
    vscode.workspace.registerTextDocumentContentProvider('hunkyard-snapshot', {
      provideTextDocumentContent: (uri) =>
        documents.get(uri.toString()) ?? 'Frozen source no longer loaded. Reopen its review.',
    }),
    vscode.commands.registerCommand('hunkyard.reviewStaged', () => invoke(true)),
    vscode.commands.registerCommand('hunkyard.history', () => invoke(false)),
    vscode.commands.registerCommand('hunkyard.clear', () => {
      session = undefined;
      documents.clear();
      changed.fire();
    }),
    vscode.commands.registerCommand('hunkyard.openFinding', async (id: string) => {
      if (!session || !vscode.workspace.isTrusted) return;
      const source = frozenFindingSource(session, id);
      const uri = vscode.Uri.from({
        scheme: 'hunkyard-snapshot',
        path: `/${session.runId ?? session.id}/${source.path}`,
        query: id,
      });
      documents.set(uri.toString(), source.text);
      const doc = await vscode.workspace.openTextDocument(uri);
      const line = Math.max(0, Math.min(source.line - 1, doc.lineCount - 1));
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(line, 0, line, 0),
        preview: true,
      });
    }),
  );
};
