# ReviewLab

Local-first Git code review with explicitly approved file fixes. The Phase 7 candidate adds local npm packaging, backup/recovery, declarative reviewer plugins and bounded large-diff rendering alongside GitHub PR capture and separately confirmed comment publication to the durable CLI/browser workflow in [the PRD](docs/PRD.md). See [Phase 7 verification](docs/implementation/PHASE-7-VALIDATION.md) for evidence and limits. Reviews preserve partially staged content and retain frozen changed-source bytes. Default inference stays on loopback; hosted inference requires explicit per-repository consent and cloud mode.

## Run from any Git project

After the one-time local installation below, run `reviewlab` from a Git project's root or any subfolder. It detects the repository and opens its browser workspace. Choose the review scope there; startup does not run inference or change your source/index. Keep the terminal running and use Ctrl+C to stop.

```sh
# One-time build and installation, from the ReviewLab source checkout:
pnpm package:release
pnpm --dir dist/release pack --pack-destination ../
npm install --global ./dist/reviewlab-cli-0.1.0-rc.3.tgz

# From the project you want to review:
reviewlab
```

Package managers are needed for building/installing, not everyday use. Node22.22.x and Git remain runtime requirements. The command uses your active Node installation's global bin directory. If `reviewlab` is unavailable after switching Node versions, install it for that version or use its configured bin path. The local tarball is not published.

Use `reviewlab --help` for help, `reviewlab --repo /absolute/path/to/repo` to choose another repository, or `reviewlab --no-browser` for manual browser connection. `reviewlab open` remains an explicit alias. Model/provider setup is required before starting an AI review; see Local review below.

## Setup

Use Node 22.22.2, Git and pnpm 10.0.0. Build a local installable npm candidate with `pnpm package:release`, verify it using `pnpm smoke:release`, then follow the [install/upgrade/uninstall checklist](docs/release/checklist.md). The candidate is not published. Linux/Windows release smoke and manual accessibility/security sign-off remain pending.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
```

On Linux, install Chromium system dependencies with `pnpm exec playwright install --with-deps chromium`. Tests need neither model credentials nor GitHub. Commands below run from this workspace and target an existing repository using `--repo`.

## Collaborative review and approved fixes

Open a session in the browser. Each finding supports open/investigating/accepted/fixed/dismissed/stale/reintroduced decisions with an audit trail. Dismissals require a reason: false positive, preference, accepted risk, duplicate or out of scope. These are user decisions; accepting or fixing a finding does not prove its correctness.

The conversation selector switches between a session thread and each finding. Save notes/decisions, reply to messages, react or ask a selected model. Messages retain their original run/snapshot and finding citations across restarts and edits. Questions use the **current configured endpoint and consent**, displayed above the workspace. Failure retains the question. No assistant tools can approve or apply files.

Select a file and open the local Monaco editor for read-only split/unified views and finding markers. Alt+F1 opens editor accessibility help. Native patch text remains available; Alt+J/Alt+K focus its next/previous changed line. Search/severity controls filter findings. Desktop side panes and the editor can be resized; small screens retain the existing responsive layout.

Under **Propose and approve a file fix**, select a changed UTF-8 file and edit the full replacement, or request a model draft. Create and inspect the exact preview, review application side effects, approve the fixed destination, then apply. Each approval is single-use. Direct writes require the working file to match the frozen bytes exactly; partial staging with newer unstaged edits therefore refuses application. No fuzzy merge, implicit staging or forced overwrite. Backups are retained at `<file>.reviewlab-<proposal>.bak`; they may contain secrets. Exclude/remove backups explicitly after inspection. A conflict preserves editor-created files and the original backup. Inspect both before recovery; do not blindly restore over newer edits. An interrupted `applying` record must be inspected manually and cannot be replayed.

Choose an isolated worktree to experiment without touching developer files. Approval discloses `git commit-tree` and detached `git worktree add` effects under `.reviewlab/experiments/<proposal>`, with filters/hooks disabled. No tests or pushes run automatically. Inspect and test there yourself, then explicitly remove the experiment using `git worktree remove <displayed path>` after preserving anything needed. This is a local commit object, not a commit on your branch.

Recapture/rerun can target paths (one per line). Old anchors and messages stay tied to old snapshots. Only unique defect/source-context matches carry decisions. A matched previously fixed finding becomes reintroduced; missing/ambiguous findings stay stale/uncertain in the comparison timeline rather than silently resolved. Staged reruns still need you to stage deliberately before recapture.

After two preference dismissals, request a rule suggestion. Accepting it affects only future reruns of that session, with frozen instruction provenance; it never silently changes repository rules.

SQLite marker9 migrates existing history automatically and preserves old runs. Back up `.reviewlab` and external config/secrets before upgrading; older versions refuse schema9. Source-inclusive exports include conversations, patches and PR context/receipts; default summary exports omit their content. See [ADR 0008](docs/adr/0008-interaction-and-approved-remediation.md) for filesystem trust/race limits and bounded draft/file sizes.

## Local review

Run your Ollama server on `http://127.0.0.1:11434` and load a local coding model. ReviewLab does not download models or start Ollama. Configure the exact installed model name; the initial `qwen2.5-coder:7b` name is a configurable default, not a quality or hardware guarantee.

```sh
pnpm reviewlab config --repo /absolute/path/to/repo \
  --provider ollama --endpoint http://127.0.0.1:11434 \
  --model YOUR_INSTALLED_MODEL --privacy local-only
pnpm reviewlab doctor --repo /absolute/path/to/repo
pnpm reviewlab review --staged --repo /absolute/path/to/repo
pnpm reviewlab sessions --repo /absolute/path/to/repo
pnpm build
pnpm reviewlab open --repo /absolute/path/to/repo
```

Stage your intended changes before reviewing. Capture uses fixed Git base/index trees, including unborn and detached HEAD. Later staging cannot change the captured input; no checkout, reset, stash, stage, commit, push or source-file edit occurs. `write-tree` and the unborn empty-tree command may write Git objects or refresh index cache metadata.

## Specialist reviews

```sh
pnpm reviewlab review --staged --profile standard --repo /absolute/path/to/repo
pnpm reviewlab review --staged --profile deep --verify --agent-concurrency 2 \
  --agent-model security=your-installed-security-model --repo /absolute/path/to/repo
```

Quick runs correctness with a 40,000-token reservation limit. Standard adds security and frontend/accessibility with 120,000 tokens. Deep adds architecture/performance and testing with 240,000 tokens. These defaults are planning limits, not quality guarantees. `--token-budget N` overrides the profile limit, capped by the configured `maxReviewTokens`. Each request reserves a conservative UTF-8 byte input bound plus maximum output tokens, including repair and retry attempts. Unused reservations are not refunded. Model-reported token counts are shown separately; missing usage or prices remain explicitly incomplete.

`--verify` adds an independent request after deduplication. It confirms unchanged supported candidates; it cannot invent findings or change their evidence. Unconfirmed candidates remain in saved agent results. All five specialists receive the same admitted frozen diff, scoped rules and related context. Conservative dedup matches path/side/line, normalized title, exact evidence and normalized recommendation. Different wording can remain separate; distinct defects at the same line are never merged solely by location. Attribution retains every contributing agent's exact model target. New reviews use critical/high/medium/low/info severities and optional qualitative confidence; old major/minor values remain readable.

The browser scope form exposes profiles, verifier, queue priority, agent concurrency and model routes before starting. Every source destination is shown. Per-agent routes inherit repository privacy, consent and repository identity; local-only mode cannot be overridden by an agent assignment. Compatible endpoints remain literal loopback addresses. No capability-based automatic routing or cloud fallback occurs. Set the provider, endpoint and installed model explicitly; use the existing capability probe to check runtime support.

Session concurrency (`config --max-concurrency`) and within-review agent concurrency are separate limits. At most 32 active/queued sessions are admitted; interactive jobs precede pending background jobs without preempting running work. Equal priorities retain admission order. `--retries 0–2` retries only transient transport failures, using the same source, model target, shared budget and per-agent deadline. Schema/source failures have one bounded repair and then fail visibly. Cancellation stops queued dispatch and active transport; a failed specialist makes the run failed, with validated candidates retained for inspection and no partial successful finding list.

Use `--review-options JSON` on review/rerun for advanced routes, prices and caps. Model assignments can specify any model configuration field except privacy; consent and secrets remain managed outside the repository. For example, a local routing override:

```sh
pnpm reviewlab review --staged --profile standard --repo /absolute/path/to/repo \
  --review-options '{"agentModels":{"security":{"provider":"lm-studio","endpoint":"http://127.0.0.1:1234","model":"your-installed-model"}}}'
```

User config may include a `review` object for defaults. The browser changes apply to the selected run. Reruns preserve review options/routes while refreshing the base model settings and rules; CLI review flags can override them. A hosted `maxCostUsd` cap requires explicit `prices` for each hosted agent, including the verifier: `{"correctness":{"inputPerMillion":1,"outputPerMillion":2}}`. Prices are supplied estimates in USD, not fetched billing rates; local hardware cost is excluded. Existing cloud mode and repository consent are still required.

## Quality benchmark

```sh
pnpm benchmark --output docs/implementation/PHASE-4-BENCHMARK.md
# Explicitly sends seeded synthetic fixture source to the configured model:
pnpm benchmark --live --model your-installed-model --model another-installed-model \
  --output /absolute/path/to/live-quality-report.md
```

The default benchmark uses two scripted responders and does not contact models. Five seeded bug patterns each have a safe counterpart. Twelve runs compare profiles with/without verification; the saved [synthetic report](docs/implementation/PHASE-4-BENCHMARK.md) validates the harness and does not measure inference quality. Live mode uses the current configured provider, consent, secrets and shared limits; each supplied model runs all profiles on that target without per-agent routing overrides. Fixture rules are empty and independent of personal configuration. Scores match frozen file/line anchors; manually adjudicate explanations and same-line false claims before treating scores as quality evidence. Live fixture history is disposable, and only the report is retained. No real-model quality claim has been verified in this environment.

## Git scopes

```sh
pnpm reviewlab review --unstaged --repo /absolute/path/to/repo
pnpm reviewlab review --working-tree --include-untracked --repo /absolute/path/to/repo
pnpm reviewlab review --staged --path 'src/**' --path 'tests/' --repo /absolute/path/to/repo
pnpm reviewlab review --branch main --repo /absolute/path/to/repo
pnpm reviewlab review --from HEAD~3 --to HEAD --repo /absolute/path/to/repo
```

Unstaged compares the index with byte-exact working content; combined compares HEAD with working content and includes staged additions/deletions. Untracked files are opt-in for either local working scope. Paths are relative to the repository root even when launched in a subdirectory. Branch uses the merge-base with the resolved base reference; ranges compare the two resolved endpoints directly, not merge-base. Detached HEAD and linked worktrees work. `--rename-threshold 1–100` sets similarity (default 50). Select one scope; missing commits/merge-bases and unresolved local merge conflicts fail explicitly. No fetch occurs automatically.

Working scopes use a temporary index, stream raw file blobs with clean filters/textconv disabled and require two matching passes plus stable HEAD/index. This deliberately preserves CRLF and avoids executing repository filters; it can differ from Git's normalized diff in an autocrlf/filter-enabled repository. Continuous edits fail after three attempts. Sparse checkout supports staged/branch/range capture; working scopes fail with guidance to use a full checkout. Working capture currently scans all tracked files twice (limit 20,000 paths), so prefer staged or committed scopes in large repositories. Capture may create Git objects/cache metadata; staged entries, source files, HEAD and branches stay unchanged. The browser offers the same scopes and a coverage inspector. Recapture reuses the session's original scope, refs and selected paths.

The browser shows history, changed files, unified diff, anchored findings, severity filters, dismissal, cancellation, model settings and snapshot/rule provenance. The source destination is visible before a review. A zero-finding result is a valid review, not proof that the code is defect-free.

`review --staged --json` and `sessions --json` print full local records, including retained source. Treat redirected output as sensitive. Text mode shows findings and the session ID. Exit codes: 0 successful command (including completed reviews with findings), 1 error/failed readiness, 130 cancelled CLI review. `doctor --no-probe` checks configuration without contacting a model endpoint. `--help` lists flags; `open --port 4318` chooses another loopback port.

## Browser authorization and development

`open` starts a foreground server on `127.0.0.1:4317` and launches the built app. Keep the process running; Ctrl+C stops it and cancels active work. The random per-process API token is passed in a browser fragment, read into memory and immediately removed from the URL. It is not stored in browser storage, sent to the server as a URL, or included in normal server logs. Reloading requires reconnecting.

`open --no-browser` explicitly prints the temporary API token to the terminal for manual connection. Do not share that output. Bindings are loopback only; the API also verifies Host, bearer token, exact Origin and a CSRF header on mutations. Provider keys never enter browser JS.

For development, build once, then:

```sh
REVIEWLAB_REPO=/absolute/path/to/repo pnpm dev
```

Open `http://127.0.0.1:5173` and enter the temporary token from the backend terminal. The Vite proxy preserves the authorization checks. Backend restarts rotate the token. `pnpm dev:web` runs only the UI; `pnpm dev:server` runs the watched, authenticated CLI server.

## Hosted review and privacy

DeepSeek and AgentRouter now have named hosted adapters with per-repository, exact-origin consent. Use the [hosted provider setup guide](docs/power-users/hosted-providers.md) for API keys, current model examples and browser/CLI setup. Local `compatible` endpoints remain loopback-only.


The OpenAI adapter uses only `https://api.openai.com`. Set `OPENAI_API_KEY` in the CLI/server environment, outside tracked files. Then explicitly select both cloud mode and repository consent:

```sh
pnpm reviewlab config --repo /absolute/path/to/repo \
  --provider openai --endpoint https://api.openai.com --model gpt-4.1-mini \
  --privacy cloud-allowed --allow-cloud
```

The browser settings offer the same explicit consent, naming the frozen diff, related code and advisory rules that will leave the machine. Use `config --revoke-cloud` to revoke consent for this repository. Returning to `--privacy local-only` blocks hosted review even if consent remains recorded. Queued hosted reviews recheck consent before execution. Cancel an active review when revoking access; already transmitted data cannot be recalled.

No automatic fallback, remote embeddings/search/discovery or telemetry exists. Ollama URLs must use literal `127.0.0.1` or `[::1]`; DNS names, LAN addresses, endpoint credentials, query strings and redirects are refused. Known cloud-backed model names are rejected in local-only mode. This protects ReviewLab's own outbound requests; the separately operated local runtime must itself be configured for local inference. A malicious loopback proxy or remote-capable runtime is outside this process's network boundary.

Known credential patterns and private-key blocks are redacted before inference. This is bounded detection, not an exhaustive secret detector. Frozen local snapshots retain original source bytes. Protect the local account and review storage accordingly.

## Configuration and advisory rules

User configuration lives at `~/.config/reviewlab/config.json`, or the explicit `REVIEWLAB_USER_CONFIG` path. The path must be outside the reviewed repository. Writes use owner-only permissions, an atomic rename and a single-writer lock. Model/privacy settings are global; consent is keyed to the canonical repository root, so moving a repository requires fresh consent. Provider secrets can stay in the server environment or be stored in a separate private `provider-secrets.json` file beside user config. The browser can submit a key but never retrieves stored values. `OPENAI_API_KEY` overrides the stored OpenAI key. Files require owner-only permissions on POSIX; this is private local storage, not encryption or a system keychain. Windows ACL behavior remains unverified.

Store a key through stdin, avoiding command arguments and shell history, or use the model settings form:

```sh
pnpm reviewlab config --repo /absolute/path/to/repo --provider openai --store-key < /private/path/provider-key
pnpm reviewlab config --repo /absolute/path/to/repo --provider openai --clear-key
```

These key commands affect secret storage only. They do not enable hosted inference or change repository consent.

User config accepts `version: 1`, `model`, `rules: string[]`, `cloudConsent` and optional `contextCloudConsent`/`cloudDestinations`. Destination grants are repository-scoped HTTPS origins; legacy consent applies only to OpenAI. Phase3 requires renewed repository consent for the selected diff, related source context and rules. Existing Phase1/2 hosted consent does not authorize the expanded inputs: run `config --allow-cloud` again or approve the updated browser consent, with cloud mode selected. Revocation clears both consent records. The `config` command updates model/consent settings; global advisory rules can be edited in this file. Project `.reviewlab/config.json` accepts **only**:

```json
{
  "rules": ["Prefer actionable correctness findings with concrete evidence."],
  "exclude": ["vendor/", "generated/schema.ts"]
}
```

Exclusions and selected paths support root-relative `*`, `**` and `?` globs; a trailing `/` selects a subtree. They apply to either side of a rename. `.gitignore` controls untracked discovery; it is not a security policy for already tracked content. The manifest lists every changed path in the captured trees; excluded, binary, non-UTF-8, LFS, submodule and over-budget files have explicit omission reasons. Their bytes are not retained for model review. Generated/vendor files are skipped for related-code navigation; explicitly exclude them to omit changed-file review too. Symlinks are captured as target text, never dereferenced. Submodule pointers are recorded; dirty nested files require a separate review in that repository. LFS objects are never downloaded.

Instruction adapters discover root/nested `AGENTS.md` and `CLAUDE.md`, root `.github/copilot-instructions.md`, `.reviewlab/review.md`, `.cursor/rules/**/*.mdc`/`.md`, and `.pr_agent.toml`. Nested instructions apply only under their directory, including deleted/renamed paths. Cursor supports inline comma-separated or bracket-list `globs` and boolean `alwaysApply` frontmatter; manual/agent-requested rules without automatic applicability remain inspectable but are omitted. Cursor YAML features such as multiline lists, braces and negation are not supported. The Qodo TOML adapter applies only `pr_reviewer.extra_instructions` in a single-line double-quoted or triple-double-quoted value; other settings are reported as unapplied. These formats are not treated as interchangeable permissions.

Precedence runs from root adapters to deeper `AGENTS.md`/`CLAUDE.md`, then project advisory rules, then global user rules. Root adapter order is AGENTS, CLAUDE, Copilot, ReviewLab, Qodo, then sorted Cursor rules. Later wins within advisory text. Optional `instructionOrder` places listed source paths last in exactly that order, letting you choose precedence explicitly. `instructionSources` selects enabled adapters (`agents`, `claude`, `copilot`, `cursor`, `pr-agent`, `reviewlab`; all enabled by default). The inspector shows file applicability and potential conflicts from overlapping sources; it does not claim to understand arbitrary prose contradictions. Hashes, format, content and truncation are frozen per run. Sources allow at most 12 KB of advisory text each; root/project/user instructions have a 48 KB bound. All repository/config rules remain untrusted advisory data under the trusted read-only/privacy system policy.

Optional `contextBytes` (1,024–100,000; default 24,000) caps additional context. Deterministic navigation uses the frozen target tree: relative JS/TS imports, declared symbols/references and matching `*.test`/`*.spec` filenames. It scans at most 200 JS/TS files and roughly 500 KB, reads at most 100 KB per related blob and includes up to 80 lines per candidate. It uses textual navigation, not a typechecker; aliases, dynamic imports and other languages have limited coverage. The model input budget reserves output and system framing, prioritizes complete file diffs, then related context. Every omitted diff and partial excerpt has a reason in the context manifest. Known secrets are redacted before inference and in retained context excerpts. Findings can anchor only to included changed lines, never related-code excerpts. If Git has pruned a saved navigation tree, reruns visibly use retained changed sources; historical context remains inspectable.

```json
{
  "rules": [],
  "exclude": ["vendor/**", "**/*.generated.ts"],
  "instructionSources": ["agents", "claude", "cursor"],
  "instructionOrder": ["CLAUDE.md", "AGENTS.md"],
  "contextBytes": 24000
}
```

## Durable runs and progress

Sessions survive restart and hold multiple review runs. Each run freezes its snapshot, instruction bundle, model settings and context manifest. Findings record their run and context IDs; dismissals are stored separately with user attribution and timestamps. Historical runs keep their original source anchors. Rerunning uses current model settings and rules; choose the retained snapshot or explicitly recapture the original scope and path selection. Findings are not reconciled across snapshots until a later phase.

```sh
pnpm reviewlab rerun --repo /absolute/path/to/repo --session SESSION_UUID --revision CURRENT_REVISION
pnpm reviewlab rerun --repo /absolute/path/to/repo --session SESSION_UUID --revision CURRENT_REVISION --recapture
```

The browser's run selector and timeline read saved history. Progress streams through an authenticated SSE connection with persistent cursors, replay and reconnect. Progress contains lifecycle and request/response/repair milestones, not raw generated token text. The API supports `Last-Event-ID` or `?after=CURSOR`; browser authorization uses headers and remains in memory.

One writer process owns a repository at a time. Stop `open` before a standalone CLI review; read-only `sessions`, `doctor`, `storage` and `export` commands can run alongside it. A dead owner can be replaced; live or uncertain owners are refused. A new writer cancels interrupted queued/running runs transactionally with a saved diagnostic, retaining snapshots and completed history. It never automatically resends source or resumes paid inference. Start a new run to retry. `doctor` itself does not recover a live process.

## Local runtime compatibility and budgets

Ollama uses native `/api/chat` and `/api/tags`. LM Studio, llama.cpp and generic compatible servers use OpenAI-compatible chat/model operations with literal loopback URLs. For example:

```sh
pnpm reviewlab config --repo /absolute/path/to/repo --provider lm-studio --endpoint http://127.0.0.1:1234/v1 --model INSTALLED_MODEL
pnpm reviewlab config --repo /absolute/path/to/repo --provider llama-cpp --endpoint http://127.0.0.1:8080/v1 --model INSTALLED_MODEL
pnpm reviewlab config --repo /absolute/path/to/repo --provider compatible --endpoint http://127.0.0.1:8080/v1 --model INSTALLED_MODEL
```

These runtimes are user-managed. Generic-compatible endpoints are currently local only; remote/LAN/DNS endpoints are refused even in cloud-allowed mode. OpenAI remains the explicit hosted target. No automatic provider fallback exists.

Settings include temperature, top-p, context-window hint, output cap, whole-review token budget, concurrency limit and timeout. CLI config accepts `--temperature`, `--top-p`, `--context-window`, `--max-tokens`, `--max-review-tokens`, `--max-concurrency` and `--structured-output json|schema|text`. Hints do not prove a model's actual context size. Reviews enforce a conservative UTF-8 byte bound for prompt tokens plus reserved output, across at most two requests; whole changed-file diffs or extra context are omitted with recorded reasons to fit input budgets; an actual request exceeding the remaining budget fails before egress. Limits are configurable. No claim of exact tokenizer accounting or dollar-cost estimation is made.

“Test saved endpoint” checks model availability. The separate capability test sends a small synthetic JSON task without repository source; hosted tests can incur a small inference charge and require existing consent. It reports observed schema support, unknown tool support and any configured context hint. Results cache for 60 seconds per target/model configuration. Compatible mode does not imply JSON-schema support; choose JSON or tool-less text mode when needed. All review responses still undergo schema/range validation and one bounded repair. Revoking hosted consent blocks subsequent requests, including repair; already-sent requests cannot be recalled.

## Storage, migration and retention

The active backend is SQLite at `.reviewlab/sqlite/history.db` in the target worktree. Ignore `.reviewlab/sqlite` and old history directories there; ReviewLab does not edit your `.gitignore`. WAL/full synchronous commits, foreign keys, migration history, immutable snapshot/policy references and session revision checks protect stored history. SQL schema 4 separates runs, mutable finding dispositions and the durable event journal. New run records refer to frozen source instead of duplicating its bytes. The bundled Node SQLite API emits an experimental warning on the pinned version.

Existing Phase 1 JSON history requires explicit import before opening the workspace:

```sh
pnpm reviewlab migrate-history --repo /absolute/path/to/repo
```

Stop ReviewLab writers for the repository first. The command validates all v2 records and retained snapshots, imports atomically, preserves originals, and reports imported/unchanged counts. Exact repeats remain safe after new SQLite runs or explicit deletion because import baselines are retained. Changed/divergent source records reject import instead of overwriting either history. SQLite schemas 1–3 upgrade transactionally. Unrecognized/newer schemas fail visibly. Starter v1 `.reviewlab/sessions` files stay untouched: missing frozen provenance cannot be reconstructed safely. Legacy imports retain their original missing context-manifest status; all new runs have manifests. Repository move migration remains unsupported.

Directories/files are private; symlink and hardlink escapes are refused. Retained source survives Git pruning and later staging. Diff input is limited to 350,000 bytes, reviewable blobs to 1 MB each and retained source to 8 MiB per snapshot. Files outside these bounds keep manifest metadata and an omission reason. Working capture streams blobs into Git without loading large files into memory; it still incurs local disk I/O and writes Git objects/cache metadata. Known secrets may remain in frozen local source, so protect the local account and storage.

All history is kept by default. The browser offers explicit session deletion and retention by cutoff plus newest sessions to keep, with confirmation. CLI equivalents:

```sh
pnpm reviewlab storage --repo /absolute/path/to/repo
pnpm reviewlab export --repo /absolute/path/to/repo --session SESSION_UUID > diagnostic.json
pnpm reviewlab export --repo /absolute/path/to/repo --session SESSION_UUID --include-source > private-source.json
pnpm reviewlab delete --repo /absolute/path/to/repo --session SESSION_UUID --revision CURRENT_REVISION
pnpm reviewlab retain --repo /absolute/path/to/repo --before 2026-10-01T00:00:00.000Z --keep-latest 10
```

Diagnostic export omits source, instruction text, source paths, finding text and endpoint identifiers by default. `--include-source` explicitly exports the full local records; treat the output as sensitive. Deletion removes review-owned records and unreferenced inputs, leaving repository files and migration originals untouched. Active sessions cannot be deleted; retention skips active runs and the configured newest sessions. Storage usage reports database allocated bytes; deletion does not promise immediate disk shrink or secure erasure. Retention is user-triggered, with no automatic expiry. Backups must be taken with writers stopped and include any WAL sidecars; automated backup/import tools are not delivered in this phase.

SQLite work is synchronous and large-history queries are not benchmarked. Lock waits are capped at 100 ms, and connections close after each operation. Filesystem races by another process with the same account privileges remain outside observed validation.

## Validation and architecture

```sh
pnpm lint
pnpm typecheck
pnpm check:boundaries
pnpm check:secrets
pnpm test
pnpm build
pnpm test:e2e
```

Vitest covers real Git fixtures, SQLite migration and crash recovery, retained source integrity, historical runs, event replay, policy restrictions, model compatibility/budgets/secrets and egress/API boundaries. Playwright runs the real Hono API and Ollama HTTP adapter against a disposable Git repo and a deterministic loopback model fixture; it also executes CLI commands and opens the production build. No hosted inference occurs in these checks. Live model quality and Linux/Windows runtime behavior are separate, unobserved validations.

The modular core depends only on domain contracts. The server composes Git, context, storage and model adapters; UI and CLI share that service. Native HTTP transports replaced the starter's unused AI SDK to make endpoint gating, redirects, deadlines and retries explicit. Official adapter contracts: [Ollama chat](https://docs.ollama.com/api/chat), [Ollama model list](https://docs.ollama.com/api/tags), [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat).

Use Conventional Commit messages and the existing `.githooks/commit-msg` once this checkout has Git metadata. [ADRs](docs/adr/), [CHANGELOG.md](CHANGELOG.md) and [PROGRESS.md](docs/implementation/PROGRESS.md) record decisions, migration details and the canonical next action. Phase 6 is implemented on the primary platform; stop at the owner gate before Phase 7. Linux/Windows fixture jobs are configured but have not been executed in this local session.


## GitHub PR review and formal handoff

Install `gh` and authenticate in your terminal with `gh auth login --hostname github.com`. Your account needs read access to PR source/comments and, for optional publication, permission to create an issue comment. Organization SSO or fine-grained-token permissions may require separate authorization. ReviewLab never stores GitHub credentials in its configuration or browser. Only github.com is supported, and the PR repository must match the checkout's HTTPS/SSH `origin`.

GitHub access is blocked in local-only mode. To use GitHub with a local inference model:

```sh
pnpm reviewlab config --repo /absolute/path/to/repo --privacy cloud-allowed
pnpm reviewlab pr review 123 --repo /absolute/path/to/repo --allow-github
pnpm reviewlab review --pr https://github.com/owner/repo/pull/123 --repo /absolute/path/to/repo --allow-github --profile standard
pnpm reviewlab open --repo /absolute/path/to/repo
```

`cloud-allowed` permits separately consented GitHub requests; it does not select a hosted model. Hosted inference still requires its own repository consent. Keep `open` stopped while launching CLI reviews because one runtime owns writes. The browser's “Review a GitHub pull request” form can launch reviews while `open` is running, with its own explicit GitHub checkbox and visible review plan. PR capture reviews the full PR; local path/untracked/ref flags are refused.

PR capture freezes GitHub base/head/merge-base IDs, source diff, reviews/comments/checks and their capture time. Git fetches run in a disposable bare repository; developer files, index and refs are preserved. Remote metadata changes during ingestion and head changes during fetch cause refusal. Source omissions remain visible. Local checkout rules apply. Related-file navigation and isolated patch worktree experiments are unavailable for remote snapshots; direct patches still need exact preview, approval and matching local bytes.

Reopen saved sessions without a network request. “Rerun frozen snapshot” also works with local inference in local-only mode. Explicit “Refresh PR & review new snapshot” requires GitHub consent and preserves old evidence; force-push/old-commit inline comments are labeled outdated. CLI refresh:

```sh
pnpm reviewlab rerun --repo /absolute/path/to/repo --session SESSION_UUID --revision CURRENT_REVISION --recapture --allow-github
```

In the GitHub panel, choose findings and prepare the exact comment preview locally. Review the body, then enable GitHub requests and use the separate “Confirm & publish” button. This posts one PR timeline comment with immutable source links, not an approval or inline review. A moved/closed PR refuses publication until refreshed. Known secrets are redacted and untrusted Markdown escaped; inspect all content before sharing it. No CLI command publishes, pushes or merges.

A lost response may mean a comment was already posted. Publishing/uncertain receipts survive restart. “Check GitHub for publication receipt” can recover a matching marker but never reposts an uncertain attempt. Exact finding markers guard duplicates across reruns/sessions; edited/deleted markers or semantically reworded findings are not a guarantee of duplicate detection. Inspect GitHub manually when uncertain. Long rate-limit cooldowns and permission failures are visible; only reads have one bounded transient retry. Lists over 1000 entries per category fail visibly; remote prose truncation and reviewer context budgets are disclosed.

Qodo comments/checks appear read-only when accessible. If an external result is unavailable, add a session note with its text and source link. Continue your organization's mandatory Qodo/reviewer process normally; ReviewLab never certifies that gate.

Schema 6 automatically preserves PR provenance/publication receipts without rewriting old history. Back up `.reviewlab/sqlite` before upgrade; older applications refuse schema 6. Source-inclusive exports contain remote discussion and publication text; diagnostic exports omit it. See [ADR0009](docs/adr/0009-github-pr-handoff.md) and [Phase 6 validation](docs/implementation/PHASE-6-VALIDATION.md). No live GitHub publication was performed during implementation.

## Hardening and extensions

- [Backup and recovery](docs/release/recovery.md): consistent history backups, validated restore to an absent destination, preservation of interrupted reviews and publication receipts.
- [Public declarative agent API v1](docs/extensions/agent-api.md) and [complete example](examples/plugins/resource-lifetime.json): explicit snapshot/context permissions, frozen plugin provenance, no executable third-party modules.
- [Troubleshooting](docs/troubleshooting.md), [accessibility flows](docs/ux/flows.md), [threat model/privacy review](docs/security/threat-model.md) and [release gates](docs/release/checklist.md).

SQLite schema 7 prevents older readers from dropping plugin policy provenance. Back up before upgrade; downgrade requires the matching pre-upgrade backup. Unversioned user configuration migrates without granting related-source consent; an explicit config update preserves a `.v0.bak` before writing v1. No background updater or telemetry is added.

## Power-user components

Phase 8 adds an opt-in [VS Code extension](docs/power-users/vscode.md), [local semantic context, shared review policies, workflow DAGs, benchmark preset candidates and local effectiveness analytics](docs/power-users/README.md). `reviewlab plan` previews all reviewer destinations; `reviewlab --help` lists opt-ins. Existing local-only defaults remain enforced. Phase 7 release/sign-off gates and Phase 8 validation limits remain in [progress](docs/implementation/PROGRESS.md).
