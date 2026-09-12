# Changelog

All notable changes to gitmancer are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

## [0.6.0] — 2026-09-12

### Added
- **`plugin list|new|remove|path`** — user plugin system: `~/.gitmancer/plugins/*.js`
  provide both new CLI commands (`run()`) and first-class AI agent tools
  (`tools[]`); mutating plugin tools pass the same confirm gate as built-ins.
- **`mcp`** — MCP server mode: gitmancer tools (`repo_status`, `list_files`,
  `read_file`, `run_cmd`, `secscan`) exposed over stdio JSON-RPC (protocol
  2024-11-05) for IDEs and other agents; read-only by default, mutating
  `run_cmd` requires `GITMANCER_MCP_ALLOW_RUN=1`.
- **`completions bash|zsh|fish`** — shell completion scripts with per-command
  flags and `--preset`/`--state` value completion; live-tested by sourcing the
  generated script and resolving completions.
- **`record "<cmd>"` / `replay <file|--list>`** — asciinema v2 session recording
  with live tee-through; replays any v2 cast with `--speed`, idle gaps capped
  (and labelled as such).
- **`plan "<goal>" --write plan.json` / `execute [plan.json]`** — plan/execute
  orchestration: AI drafts ordered steps (max 12), execute runs shell steps
  confirm-gated + exit-checked and agent steps through the full agent;
  `--from` / `--only` / `--dry-run` / `--keep-going` / `--json`.
- **`.gitmancer.json` workspace profiles** — per-project `model` / `base` /
  `preset` / `steps` / `budget` / `flags` (whitelist: fast, verify, chat) /
  `exclude`; `yolo` cannot be granted from a profile; secret-shaped keys are
  detected, ignored and called out; `profile [init]` shows the merged view.
- **`usage [--since N|--all|--json|--reset]`** — durable per-call usage log
  (`~/.gitmancer/usage.jsonl`) with per-command token totals and estimated cost
  from published $/1M rates (labelled as estimates, not a bill).
- **`ask --resume <id|last>`** — chat session persistence: transcripts saved
  after every turn to `~/.gitmancer/sessions/chat/`, restorable with full
  context.
- **`--sandbox`** (ask/fix/watch) — `run_cmd` wrapped in docker
  (`--network=none`, memory/CPU caps) or bubblewrap (`--unshare-all`);
  no runtime available → honest refusal and nothing executes.

### Changed
- e2e suite grown from 138 to 223 live checks (mock AI + mock GitHub + real
  stdio MCP server + real shell completions + real record/replay round-trips).

## [0.5.0] — 2026-09-12

### Added
- **`changelog [from]`** — AI release notes (Keep-a-Changelog style) for a commit
  range, default since the last tag; `--write` prepends a section to
  CHANGELOG.md, `--json` for scripting.
- **`release patch|minor|major`** — one-shot version bump: package.json bump,
  CHANGELOG section, `chore(release): vX.Y.Z` commit, tag, `--push --follow-tags`,
  and a GitHub Release via the API; `--no-push` / `--skip-gh` / `--dry-run` escapes.
- **`ask --verify`** — mechanically re-checks every `file:line` receipt the agent
  cites against the worktree; broken references are flagged with reasons.
- **`secscan`** — gitleaks-style secret scanning over tracked files, `--staged`
  diffs or a single `--path`: AWS / GitHub / OpenAI / Slack / Google key rules,
  private-key blocks and hard-coded secret assignments; placeholder-aware,
  redacted previews, `--json`, exit 1 on findings for CI/hook use.
- **`hook list|install|uninstall`** — managed, idempotent git-hook blocks
  (pre-commit / pre-push / commit-msg) that run secscan; existing user hooks are
  preserved (append or `--force`), uninstall keeps user code.
- **`testgen <file>`** — AI unit-test generation with per-language framework
  hints (node:test / vitest / pytest); dry preview by default, `--write` / `--yolo`.
- **`explain <target>`** — AI explanations with auto-detected target mode:
  source file, git rev or rev-range, or shell command.
- **`fleet status|pull|secscan|run "<cmd>"`** — one action across every repo
  directly under `--root`; sorted rows, `--json`, non-zero exit when any repo fails.
- **`triage <owner/repo>`** — AI triage of open issues (P0–P3 priority, type,
  label + rationale); `--apply` writes labels via the API, confirm-gated.

### Changed
- e2e suite extended to 138 checks — all green.

## [0.4.0] — 2026-09-12

### Added
- **GITMANCER.md project memory** — repo conventions auto-loaded into the
  system prompt on every agent run (capped at 1600 chars); new `memory`
  command creates a starter template (Build & test / Conventions / Do not
  touch) or shows the current file.
- **`undo [n]`** — agent file mutations (`write_file`, `batch_edit`) are
  journaled to `~/.gitmancer/undo-journal.jsonl` with the prior content;
  `gitmancer undo` restores the last change (deletes files the agent
  created), `gitmancer undo 5` reverts five. Journal caps at 200 entries.
- **`watch "<cmd>"`** — auto-fix loop: run command → if it fails, agent
  diagnoses/fixes/re-verifies → re-runs, up to `--max` attempts (default 3,
  cap 10). Green on the first run exits immediately.
- **`batch_edit` agent tool** — several exact string replacements inside one
  file per call; each `find` must match exactly once unless `replace_all`;
  confirm-gated like `write_file`, journaled for undo.
- **`prbot`** — polls open PRs on a repo and AI-reviews each new head
  (severity-tagged findings posted as a PR comment, confirm-gated);
  `--interval 300` daemon sweep or `--once` single pass; reviewed heads
  remembered in `~/.gitmancer/prbot.json` so re-runs skip them.
- **Token metering + `--budget`** — `usage:` summary line after agent runs
  (real provider usage when reported, ~char/4 estimates otherwise);
  `ask --budget N` stops the loop when the soft token cap is exceeded.
- 26 new e2e checks → 85 total: memory auto-load into the system prompt,
  memory template creation, undo round-trip (overwrite → restore),
  batch_edit multi-replacement, watch green-first-run and watch red → AI fix
  → green loop, prbot review + skip-on-rerun, budget stop, usage line.

## [0.3.1] — 2026-09-12

### Changed
- **Speed: parallel tool dispatch** — when the model batches several read-only
  tool calls (`list_files` / `read_file` / `github_api` GET), they now run
  concurrently instead of one-by-one. Mutating tools (`write_file`, `run_cmd`,
  non-GET API calls) still execute sequentially behind their confirmation
  gates, so confirmation order and filesystem effects stay deterministic.
- **Speed: request coalescing** — identical in-flight GitHub GETs now share a
  single HTTP request (the second caller joins the first one's promise),
  removing duplicate rate-limit spend when parallel calls read the same
  endpoint; the 10-minute TTL cache still sits in front of everything.

### Added
- 10 new e2e checks (41 → 51): parallel batch executes all reads with order
  preserved, mixed batches keep mutating tools confirm-gated, and the
  identical-GET cache check now also proves coalescing under concurrency.

## [0.3.0] — 2026-09-11

### Added
- `pr list | close | merge` — full PR lifecycle from the terminal: list with
  `--state all|open|closed|merged` (+ `--json`), confirm-gated close, and
  merge with `--merge|--squash|--rebase` and optional `--subject`.
- `issue reopen <n>` and `issue list --json`.
- `ship --no-push` — commit locally without pushing (batch your pushes).
- `--steps N` — raise (up to 100) or lower the agent loop step cap per run.
- `newrepo --template node-lib` — scaffold package.json / index.js /
  test/run.js / .gitignore into `--source` before the initial push.
- `repos --json`, `whoami --json` — scripted account queries.
- `ghPaginate` — Link-header-aware pagination helper; `repos` and `sweep`
  now handle >100 repos correctly.
- `list_files` (agent tool) now respects `.gitignore` patterns (basenames,
  directories, `*.ext` globs, prefix globs) → cleaner prompts, fewer tokens.
- `review <pr#>` — AI code review of pull requests with severity-tagged findings
  (`[blocking]` / `[major]` / `[minor]` / `[nit]`) and an APPROVE / REQUEST
  CHANGES / COMMENT verdict. Streams as it reviews.
- `sweep` — batch overview of **all** your repositories: language, stars,
  last push, open issues & PRs per repo, fetched 5 requests at a time.
- `status` — one-shot dashboard: branch, dirty files, ahead/behind, open
  issues/PRs, and the latest CI run for the current repo (or `--repo`).
- `doctor` — diagnoses config, keys, fallback shape, GitHub/AI endpoints;
  masks secrets, exits non-zero on critical problems.
- `--json` output for `status`, `sweep` (scripting-friendly, pure stdout).
- `run_cmd` tool accepts `timeout_ms` (default `GITMANCER_CMD_TIMEOUT` or
  120s, hard cap 10 min); timed-out processes are killed with a clear error.
- `read_file` tool accepts `offset`/`limit` (1-based lines) — page through
  large files instead of eating a hard truncation.
- `install.sh` v2: version/branch pinning argument, wget fallback,
  `uninstall` subcommand, payload sanity check, post-install smoke.

### Changed
- **Context compaction v2** — long agent turns now compact history at safe
  user-message boundaries only (never between a tool call and its result),
  keeping the system prompt, the first task message, and the recent tail.
- **Speed: GitHub GET cache** — identical GETs are served from an in-process
  10-minute TTL cache; bypass with `--no-cache`; any successful mutation
  invalidates the cache automatically.
- `--fast` now actually takes effect (config `preset` was not previously
  surfaced by `loadConfig`, so the downgrade silently no-op'd).

### Fixed
- `run_cmd` timeout previously surfaced as a generic "process error";
  it now reports the timeout and suggests raising `timeout_ms`.

## [0.2.0] — 2026-09-11

### Added
- **SSE streaming output** — agent answers render token-by-token
  (`aiChat` returns `{message, streamed}`; automatic buffered fallback for
  providers that ignore `stream`).
- **Workspace snapshot** — file tree, package.json, README excerpt, and git
  state preloaded into the system prompt → fewer exploration steps.
- **`fix "<cmd>"`** — run a command; if it fails, the agent diagnoses, edits,
  and re-verifies until it exits 0.
- **`pr`** — open pull requests with AI-drafted title & body from commits and
  diff stat (confirm-gated, `--base/--head/--repo/--title/--body`).
- **`--fast`** — downgrades to the preset's small/fast model for quick tasks.

### Changed
- e2e suite: SSE-aware mock server, request-aware routing (18 checks).

## [0.1.0] — 2026-09-11

### Added
- Initial release: 5-tool agent loop (list_files / read_file / write_file /
  run_cmd / github_api), confirmation gate with SAFE_CMD allowlist,
  `setup/config/whoami/repos/ship/newrepo/issue` commands, shorthand-ask,
  any OpenAI-compatible provider (groq/openai/openrouter/zai/ollama/custom).
