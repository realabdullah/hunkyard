# ReviewLab

Local-first AI code review for Git. ReviewLab captures a frozen snapshot of your changes, runs specialist reviewers against it with the model you choose, and gives you a browser workspace to triage findings, discuss them and approve fixes.

- **Local by default.** Works with Ollama, LM Studio, llama.cpp or any OpenAI-compatible server on your machine. Hosted providers (OpenAI, DeepSeek, AgentRouter) need explicit per-repository consent, and there is never a silent cloud fallback.
- **Any Git scope.** Review staged changes (including partial staging), unstaged or working-tree changes, a branch, a commit range or a GitHub pull request.
- **Specialist reviewers.** Correctness, security, frontend/accessibility, architecture/performance and testing, with an optional verifier pass.
- **Respects your project's instructions.** Reads `AGENTS.md`, `CLAUDE.md`, Copilot, Cursor and Qodo rules alongside ReviewLab's own config.
- **Nothing changes without you.** ReviewLab never stages, commits or pushes. Fixes are applied only after you preview and approve the exact change.
- **Persistent history.** Sessions, runs and decisions are stored locally in SQLite and survive restarts.

## Requirements

- Node.js 22.22.x
- Git
- pnpm 10 (only to build and install)
- A model: a local runtime such as [Ollama](https://ollama.com), or an API key for a hosted provider

## Install

From this repository:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm package:release
pnpm --dir dist/release pack --pack-destination ../
npm install --global ./dist/reviewlab-cli-0.1.0-rc.3.tgz
```

## Usage

Point ReviewLab at a local model (Ollama here; use a model you have installed):

```sh
reviewlab config --provider ollama --endpoint http://127.0.0.1:11434 --model qwen2.5-coder:7b --privacy local-only
reviewlab doctor
```

Then, from any Git project:

```sh
reviewlab
```

This opens the browser workspace. Pick a scope and start a review. Keep the terminal open, and press Ctrl+C to stop.

You can also review from the command line:

```sh
reviewlab review --staged
reviewlab review --branch main --profile standard
reviewlab sessions
```

Run `reviewlab --help` for all commands and options.

### Hosted models

Set the provider's API key in your environment (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY` or `AGENTROUTER_API_KEY`), then allow cloud use for this repository:

```sh
reviewlab config --provider deepseek --model deepseek-flash --privacy cloud-allowed --allow-cloud
```

Revoke it any time with `reviewlab config --revoke-cloud`.

### GitHub pull requests

With the GitHub CLI signed in (`gh auth login`):

```sh
reviewlab config --privacy cloud-allowed
reviewlab pr review 123 --allow-github
```

Publishing a summary comment back to the PR is a separate, confirmed step in the workspace.

### VS Code

See the [extension README](apps/vscode/README.md).

## Development

```sh
pnpm exec playwright install chromium
pnpm build
REVIEWLAB_REPO=/path/to/a/repo pnpm dev   # API + UI on http://127.0.0.1:5173
pnpm check                                # lint, typecheck, tests, build and e2e
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
