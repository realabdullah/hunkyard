# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Walkthrough mode: read a change yourself in dependency order, mark files read, leave line notes, then approve or request changes with a ready-to-paste message for your coding agent.

## [0.1.1] - 2026-10-17

### Changed

- Releases are now published from GitHub Actions with npm trusted publishing and provenance.

## [0.1.0] - 2026-10-17

First public release, published to npm as `@hunkyard/cli`.

### Added

- `hunkyard` command: run it in any Git repository to open the review workspace in your browser. Install with `npm i -g @hunkyard/cli` or run once with `npx @hunkyard/cli`.
- Review any Git scope: staged changes (including partially staged files), unstaged or working-tree changes, a branch, a commit range or a GitHub pull request. Each review works on a frozen snapshot, so later edits don't change its results.
- Local model providers: Ollama, LM Studio, llama.cpp and any OpenAI-compatible server on your machine.
- Hosted providers (OpenAI, DeepSeek, AgentRouter), which need explicit per-repository consent and support cost limits. In local-only mode, nothing is sent off your machine and there is never a silent cloud fallback.
- Specialist reviewers for correctness, security, frontend and accessibility, architecture and performance, and testing, plus an optional verifier pass. Choose a review profile or define a custom reviewer workflow.
- Reads project instructions from `AGENTS.md`, `CLAUDE.md`, Copilot, Cursor and Qodo rule files, plus shareable team review policies.
- Browser workspace: a canvas for each review, a diff editor, keyboard triage, a command palette, and light and dark themes.
- Finding triage with statuses and dismissal reasons, threaded discussions, follow-up questions to the model, and suggested project rules.
- Fix suggestions as patch previews. A patch is applied only after you approve the exact change, with a backup kept. Hunkyard never stages, commits or pushes.
- GitHub pull request review through the GitHub CLI, with an optional summary comment that you confirm before it is posted.
- Optional local semantic search for extra review context, using a local embedding model.
- Persistent local history in SQLite: sessions, reruns, exports, retention controls, backup and restore.
- Review analytics and preset recommendations based on your own decisions.
- `hunkyard doctor`, `config`, `review`, `sessions` and other commands for working from the terminal.
- VS Code extension that runs reviews and opens findings next to your code.

[Unreleased]: https://github.com/realabdullah/hunkyard/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/realabdullah/hunkyard/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/realabdullah/hunkyard/releases/tag/v0.1.0
