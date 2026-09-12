# Changelog

All notable changes to gitmancer are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

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
- 18 new e2e checks → 77 total: memory auto-load into the system prompt,
  memory template creation, undo round-trip (overwrite → restore),
  batch_edit multi-replacement, watch green-first-run and watch red → AI fix
  → green loop.

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
