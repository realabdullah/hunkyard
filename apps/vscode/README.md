# ReviewLab for VS Code

Run ReviewLab reviews and browse their findings without leaving VS Code.

## Requirements

- VS Code 1.95 or later
- The ReviewLab CLI 0.1.0-rc.3 or later, installed separately, with Node.js 22.22.x
- A model configured through the CLI (`reviewlab config`)

## Install

Build the extension from the ReviewLab repository, then install it with **Extensions: Install from VSIX**:

```sh
pnpm package:vscode   # creates dist/reviewlab-vscode-0.1.1.vsix
```

Packaging needs `zip` on macOS and Linux, or PowerShell on Windows.

## Settings

If `reviewlab` is not on your `PATH`, set `reviewlab.executable` in your user settings to the full path of the installed CLI.

On Windows, set `reviewlab.executable` to the installed `@reviewlab/cli/cli.mjs` file and `reviewlab.nodeExecutable` to your Node 22.22.x executable.

These settings work in user settings only, not workspace settings.

## Commands

- **ReviewLab: Review Staged Changes** shows the repository, model, destination and privacy mode, then runs a review after you confirm.
- **ReviewLab: Open Local Review History** loads past findings. Each finding opens the reviewed source in a read-only view, which may differ from your current file.
- **ReviewLab: Clear Findings View** removes loaded findings and source from memory.

The extension does not edit, stage, fix or publish anything. Your CLI privacy and consent settings still apply.

## Notes

- Trust the workspace before running commands. Virtual workspaces are not supported. In a multi-root workspace, you choose which folder to review.
- The extension runs no background server, telemetry or updater.
- Errors appear in the **ReviewLab** output channel. Run the CLI in a terminal for more detail.
- To remove it, disable or uninstall the extension.
