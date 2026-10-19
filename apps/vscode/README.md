# Hunkyard for VS Code

Run Hunkyard reviews and browse their findings in VS Code.

## Requirements

- VS Code 1.95 or later
- The Hunkyard CLI (`npm install --global @hunkyard/cli`) with Node.js 22.22 or later
- A model configured with `hunkyard config`

## Installation

Build the extension from the repository root, then install the generated `.vsix` file with **Extensions: Install from VSIX**:

```sh
pnpm package:vscode
```

## Commands

- **Hunkyard: Review Staged Changes** shows the repository, model and privacy mode, then starts a review after you confirm.
- **Hunkyard: Open Local Review History** loads past findings. Each finding opens the reviewed source in a read-only view.
- **Hunkyard: Clear Findings View** clears the loaded findings.

The extension never edits, stages, fixes or publishes code. Your CLI privacy and consent settings apply.

## Settings

| Setting | Description |
| --- | --- |
| `hunkyard.executable` | Path to the Hunkyard CLI, if it is not on your `PATH`. On Windows, point it to `@hunkyard/cli/cli.mjs`. |
| `hunkyard.nodeExecutable` | Path to Node.js on Windows. |

These settings are read from user settings only.

## Limitations

- The workspace must be trusted. Virtual workspaces are not supported.
- Errors are written to the **Hunkyard** output channel.

## License

[MIT](../../LICENSE)
