# Hunkyard

Local-first AI code review for Git.

Hunkyard takes a read-only snapshot of your changes, reviews it with the model of your choice, and opens a browser workspace where you triage findings, discuss them and approve fixes.

## Features

- **Local by default.** Runs against Ollama, LM Studio, llama.cpp or any OpenAI-compatible server. Hosted providers (OpenAI, DeepSeek, AgentRouter) require explicit per-repository consent. There is no automatic cloud fallback.
- **Any Git scope.** Staged changes (including partial staging), unstaged or working-tree changes, a branch, a commit range or a GitHub pull request.
- **Specialist reviewers.** Correctness, security, frontend and accessibility, architecture and performance, and testing, with an optional verification pass.
- **Project-aware.** Follows the rules in `AGENTS.md`, `CLAUDE.md`, and Copilot, Cursor and Qodo instruction files.
- **You stay in control.** Hunkyard never stages, commits or pushes. A fix is applied only after you preview and approve it.
- **Persistent history.** Sessions, findings and decisions are stored locally.

## Requirements

- Node.js 22.22 or later
- Git
- A local model runtime such as [Ollama](https://ollama.com), or an API key for a hosted provider

## Installation

```sh
npm install --global @hunkyard/cli
```

## Usage

Configure a model and check the setup:

```sh
hunkyard config --provider ollama --endpoint http://127.0.0.1:11434 --model qwen2.5-coder:7b --privacy local-only
hunkyard doctor
```

Other local providers are `lm-studio`, `llama-cpp` and `compatible`, each with its own `--endpoint`.

Open the review workspace from inside a Git repository:

```sh
hunkyard
```

Or review from the command line:

```sh
hunkyard review --staged
hunkyard review --branch main --profile standard
hunkyard sessions
```

Run `hunkyard --help` for all commands and options.

### Hosted providers

Set `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` or `AGENTROUTER_API_KEY`, then grant consent for the repository:

```sh
hunkyard config --provider deepseek --model <model> --privacy cloud-allowed --allow-cloud
```

Revoke consent with `hunkyard config --revoke-cloud`.

### GitHub pull requests

Requires the [GitHub CLI](https://cli.github.com) (`gh auth login`) and `cloud-allowed` privacy:

```sh
hunkyard pr review 123 --allow-github
```

### VS Code

A companion extension is available in [`apps/vscode`](apps/vscode/README.md).

## Development

Requires pnpm 10.

```sh
pnpm install
pnpm build
pnpm check
```

## License

[MIT](LICENSE)
