# Changelog

All notable changes to gitmancer are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Added
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
