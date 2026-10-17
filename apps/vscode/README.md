# Hunkyard for VS Code

Run Hunkyard reviews and browse their findings without leaving VS Code.

## Requirements

- VS Code 1.95 or later
- The Hunkyard CLI 0.1.0-rc.3 or later, installed separately, with Node.js 22.22 or later
- A model configured through the CLI (`hunkyard config`)

## Install

Build the extension from the Hunkyard repository, then install it with **Extensions: Install from VSIX**:

```sh
pnpm package:vscode   # creates dist/hunkyard-vscode-0.1.1.vsix
```

Packaging needs `zip` on macOS and Linux, or PowerShell on Windows.

## Settings

If `hunkyard` is not on your `PATH`, set `hunkyard.executable` in your user settings to the full path of the installed CLI.

On Windows, set `hunkyard.executable` to the installed `@hunkyard/cli/cli.mjs` file and `hunkyard.nodeExecutable` to your Node.js executable (22.22 or later).

These settings work in user settings only, not workspace settings.

## Commands

- **Hunkyard: Review Staged Changes** shows the repository, model, destination and privacy mode, then runs a review after you confirm.
- **Hunkyard: Open Local Review History** loads past findings. Each finding opens the reviewed source in a read-only view, which may differ from your current file.
- **Hunkyard: Clear Findings View** removes loaded findings and source from memory.

The extension does not edit, stage, fix or publish anything. Your CLI privacy and consent settings still apply.

## Notes

- Trust the workspace before running commands. Virtual workspaces are not supported. In a multi-root workspace, you choose which folder to review.
- The extension runs no background server, telemetry or updater.
- Errors appear in the **Hunkyard** output channel. Run the CLI in a terminal for more detail.
- To remove it, disable or uninstall the extension.
