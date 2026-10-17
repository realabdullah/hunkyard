const assert = require('node:assert/strict');
const vscode = require('vscode');
exports.run = async () => {
  const extension = vscode.extensions.getExtension('hunkyard.hunkyard-vscode');
  assert.ok(extension, 'VSIX identity must be discoverable');
  await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = await vscode.commands.getCommands(true);
  for (const name of [
    'hunkyard.reviewStaged',
    'hunkyard.history',
    'hunkyard.clear',
    'hunkyard.openFinding',
  ])
    assert.ok(commands.includes(name), `${name} registered`);
  await vscode.commands.executeCommand('hunkyard.clear');
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.parse('hunkyard-snapshot:/missing/example.ts'),
  );
  assert.match(doc.getText(), /no longer loaded/);
  assert.equal(doc.isDirty, false);
};
