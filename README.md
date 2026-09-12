# ⚡ gitmancer

**Zero-dependency AI CLI agent for your code & your whole GitHub account.**

Give it any OpenAI-compatible AI key (Groq / OpenAI / OpenRouter / Z.ai / Ollama / custom) plus a
GitHub token, and it becomes a terminal-native agent that reads and writes your code, runs
commands, commits, pushes, creates repos, and manages issues — you talk, it ships.

![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![deps](https://img.shields.io/badge/dependencies-0-blue) ![license](https://img.shields.io/badge/license-MIT-orange) ![version](https://img.shields.io/badge/version-0.3.0-purple)

```bash
$ gitmancer ask "add input validation to signup.js and run the tests"
⚙ read_file signup.js
⚙ write_file signup.js (1,204 bytes)
⚙ run_cmd `node --test`  →  ✔ 12 passing
Done — added validation for empty email/password and rate-limit guard. Tests pass.

$ gitmancer ship
staged 3 file(s)
commit: feat(auth): validate signup inputs + rate-limit guard
✔ pushed main → origin
```

## What's new in v0.4.0 — memory · undo · watch · batch_edit

- **GITMANCER.md project memory** — drop a file in the repo root with your conventions (build cmds, style rules, "do not touch" zones); it's auto-loaded into the AI's context on every `ask`/`agent`/`fix`/`ship`/`watch` run in that repo. `gitmancer memory` creates a starter template or shows the current one.
- **`undo`** — every agent file change is journaled to `~/.gitmancer/undo-journal.jsonl` (prior content kept); `gitmancer undo` reverts the last change, `gitmancer undo 5` reverts five. Fearless automation.
- **`watch "<cmd>"`** — run a command; if it fails the agent auto-fixes the code and re-runs until green (`--max 3` by default). Like `fix`, but loop-tolerant.
- **`batch_edit` agent tool** — the model can now make several exact string replacements in one file per call instead of rewriting whole files → fewer tokens, faster turns, smaller diffs. Exact-match enforced: a `find` matching multiple locations must pass `replace_all`.

<details>
<summary>What was new in v0.3.1</summary>

- **Parallel tool dispatch** — when the model batches several read-only tool calls (`list_files` / `read_file` / `github_api` GET), they now run concurrently instead of one-by-one; mutating tools (`write_file`, `run_cmd`, non-GET API) stay sequential behind their confirmation gates, so safety semantics are unchanged
- **Request coalescing** — identical in-flight GitHub GETs share a single HTTP request (second caller joins the first one's promise) → no duplicate rate-limit burn when parallel calls read the same endpoint

</details>

<details>
<summary>What was new in v0.3.0</summary>

- **Retry + fallback chain** — transient AI errors (429/5xx) retry with exponential backoff (respects `Retry-After`); add `aiFallbacks` to your config and gitmancer fails over to the next provider/model instead of dying
- **GitHub GET cache** — identical API reads are served from a 10-minute in-process cache (mutations invalidate it, `--no-cache` bypasses) → sweeps and status views are dramatically faster and burn less rate limit
- **`gitmancer review <pr#>`** — AI code review of any pull request: severity-tagged findings (`[blocking]`/`[major]`/`[minor]`/`[nit]`) + an APPROVE / REQUEST CHANGES verdict
- **`gitmancer sweep`** — concurrent batch overview of *all* your repos: open issues, PRs, stars, last push
- **`gitmancer status`** — branch, dirty files, ahead/behind, open issues/PRs, last CI run — one command (`--json` for scripts)
- **`gitmancer doctor`** — checks config, keys, fallback shape, GitHub/AI endpoints and tells you exactly what's broken
- **Context compaction v2** — long sessions compact safely at user-message boundaries (never mid tool-call), so marathon agent turns stay fast
- **Agent tool upgrades** — `run_cmd` gains a `timeout_ms` guard, `read_file` gains `offset`/`limit` pagination for big files
- **`--json` output** for `status` and `sweep` — pipe into `jq`, drive from scripts

</details>

<details>
<summary>What was new in v0.2.0</summary>

- **Streaming output** (SSE with buffered fallback) · **`fix "<cmd>"`** auto-repair · **`pr`** with AI-drafted title/body · **workspace snapshot** in the system prompt · **`--fast`** small-model switch

</details>

## Why

Existing AI CLIs lock you into one provider, need `npm install` rituals, or stop at your
local machine. **gitmancer** is one file, zero dependencies, provider-agnostic, and reaches
all the way to your GitHub account — code, commits, repos, issues — through the same two
keys you already have.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/qtjg/gitmancer/main/install.sh | sh

# or pin a version / uninstall
curl -fsSL https://raw.githubusercontent.com/qtjg/gitmancer/main/install.sh | sh -s v0.3.0
gitmancer uninstall
```

**Option B — single file (no install):**

```bash
curl -fsSL https://raw.githubusercontent.com/qtjg/gitmancer/main/gitmancer.js -o gitmancer.js
node gitmancer.js --help
```

**Option B — npm global:**

```bash
git clone https://github.com/qtjg/gitmancer.git && cd gitmancer
npm install -g .
gitmancer --help
```

Requires Node 18+ (built-in `fetch`). That's it — there are literally no other dependencies.

## Setup (once)

```bash
gitmancer setup
```

You'll be asked for:

| What | Where to get it | Notes |
|------|-----------------|-------|
| AI API key | [Groq](https://console.groq.com) (free) · OpenAI · OpenRouter · Z.ai | any OpenAI-compatible endpoint |
| Model | preset default or your pick | `llama-3.3-70b-versatile`, `gpt-4o-mini`, … |
| GitHub token | GitHub → Settings → Developer settings → **fine-grained PAT** | only needs *Contents: RW* + *Issues: RW* on the repos you want |

Everything is stored in `~/.gitmancer/config.json` with `chmod 600`. Keys are never logged,
never printed (last 4 chars only), and never sent anywhere except their own APIs.

## Commands

| Command | What it does |
|---------|-------------|
| `gitmancer setup` | one-time wizard for AI key + GitHub token |
| `gitmancer whoami` | verify your token — see login, repos, followers |
| `gitmancer repos` | list your repositories with stars / language / last push |
| `gitmancer ask "<task>"` | **the agent** — explores code, edits files, runs commands, calls GitHub (streaming output) |
| `gitmancer ask --chat` | same, but stays in an interactive conversation |
| `gitmancer fix "<cmd>"` | run a command; if it fails the agent auto-fixes the code & re-verifies |
| `gitmancer pr` | open a PR — AI drafts title/body from your commits (`--base main`) |
| `gitmancer pr list/close/merge` | full PR lifecycle: list (`--state all`, `--json`), confirm-gated close, merge (`--squash`) |
| `gitmancer ship ["msg"]` | stage all, AI-generated commit message (if omitted), push (`--no-push` to stay local) |
| `gitmancer newrepo <name>` | create a GitHub repo via API; `--source .` also init + commit + push; `--template node-lib` scaffolds a zero-dep library |
| `gitmancer issue <owner/repo> …` | `list` · `create "Title" --body "…"` · `close 12` · `reopen 12` |
| `gitmancer review <pr#>` | AI code review of a PR — findings + verdict (`--repo owner/name`) |
| `gitmancer status` | dashboard: branch, dirty files, sync state, open issues/PRs, CI (`--json`) |
| `gitmancer sweep` | batch overview of all your repos — open counts per repo (`--json`) |
| `gitmancer doctor` | diagnose config, keys, endpoints, fallbacks |

**Useful flags:** `--yolo` (skip confirmations for unattended runs) · `--fast` (small model per preset) · `--no-cache` (bypass GitHub GET cache) · `--json` · `--private` · `--limit N` · `--cwd <dir>`

### The agent loop

`ask` gives the model five tools and lets it drive. Before the first call it also builds a **workspace snapshot** (file tree, package.json metadata, README excerpt, git state) into the system prompt — so it usually knows your project before you finish typing.

- `list_files` / `read_file` — explore your workspace
- `write_file` — create or rewrite files
- `run_cmd` — run anything: `git`, `npm`, `pytest`, builds, linters
- `github_api` — raw GitHub REST access: repos, issues, PRs, releases, gists

Every mutation (writes, commands, API calls) asks you `[y/N/a]` first — press `a` once to
allow everything for the session. `--yolo` skips all prompts (great for CI, careful in prod).

## Providers

| Preset | Base URL | Default model |
|--------|----------|---------------|
| `groq` | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| `openrouter` | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` |
| `zai` | `https://api.z.ai/api/paas/v4` | `glm-4.6` |
| `ollama` | `http://127.0.0.1:11434/v1` | `llama3.1` |
| `custom` | your URL | your model |

Env-var overrides (CI-friendly): `GITMANCER_AI_KEY`, `GITMANCER_AI_BASE`, `GITMANCER_AI_MODEL`, `GITMANCER_GITHUB_TOKEN`, `GITMANCER_GH_BASE` (also handy for GitHub Enterprise), `GITMANCER_CMD_TIMEOUT` (default run_cmd timeout, ms).

### Reliability: retry & fallbacks

AI calls retry transient failures automatically (429/5xx, exponential backoff, `Retry-After` honored). For provider outages, add a fallback chain to `~/.gitmancer/config.json`:

```json
{
  "preset": "groq",
  "aiBase": "https://api.groq.com/openai/v1",
  "aiModel": "llama-3.3-70b-versatile",
  "aiFallbacks": [
    { "base": "https://openrouter.ai/api/v1", "model": "openai/gpt-4o-mini", "key": "sk-or-…" },
    { "base": "http://127.0.0.1:11434/v1", "model": "llama3.1" }
  ]
}
```

If the primary fails, gitmancer walks the chain and tells you which fallback served the request. Verify the whole setup with `gitmancer doctor`.

## Security

- Tokens live **only** in `~/.gitmancer/config.json` (`chmod 600`) or env vars.
- `gitmancer config` masks secrets; `git push` output is token-redacted.
- The system prompt forbids the model from writing keys into files, commands, or logs.
- Push uses your existing git credentials for `ship`; the one-shot tokened URL in `newrepo`
  is never stored in `.git/config`.
- Recommend **fine-grained PATs** scoped to just the repos you need — revoke anytime.

## Roadmap

- [x] streaming output + `fix` auto-repair + `--fast` mode (v0.2.0)
- [x] PR **review** command — AI findings + verdict (v0.3.0)
- [x] multi-repo `sweep` + `status` dashboard + `doctor` (v0.3.0)
- [x] `--json` output mode for scripting (v0.3.0)
- [x] retry on transient AI errors + provider fallback chain (v0.3.0)
- [ ] scheduled farming mode: commit queues + planned pushes
- [ ] repo templates: `newrepo --template node-lib` scaffolds + pushes a full project
- [ ] session persistence: resume an interrupted `ask --chat` where you left off
- [ ] MCP server support: expose gitmancer tools to other agents

## Contributing

PRs welcome — keep it zero-dependency and single-file, that's the whole point. Read [CONTRIBUTING.md](CONTRIBUTING.md), then: `node --check gitmancer.js && node test/mock.e2e.js` (no keys needed). Found a security issue? See [SECURITY.md](SECURITY.md).

## License

MIT

## FAQ

**Why zero dependencies?**
Every dep is a supply-chain risk and an install delay. Node 18+ ships `fetch`, so gitmancer needs nothing else — `curl | sh` is the whole install.

**Which providers work?**
Any OpenAI-compatible `/chat/completions` endpoint: Groq, OpenAI, OpenRouter, Z.ai, Ollama (local), vLLM, LM Studio, or a custom base URL. `aiFallbacks` mixes providers for automatic failover.

**Does the agent see my tokens?**
No. Keys live in `~/.gitmancer/config.json` (chmod 600) or env vars, are masked in output, and the system prompt forbids the model from writing them anywhere. `run_cmd` output is redacted for git push URLs.

**How is this different from `gh` CLI or Copilot CLI?**
gitmancer is an *agent loop*, not a command mapper: it plans across tools (read → edit → run → verify), streams its reasoning, and reaches your whole GitHub account — while staying one file you can actually read.

**Can I use it in CI?**
Yes: env vars (`GITMANCER_AI_KEY`, `GITMANCER_GITHUB_TOKEN`) + `--yolo` + `--json` make unattended runs scriptable. Keep `--yolo` scoped to trusted repos.

**What do contributions to the graph require?**
Commits count when the author email is linked to the GitHub account, the repo is not a fork, and the commit lands on the default branch. The linked noreply format `<id>+<login>@users.noreply.github.com` always works.

**How do I speed up long agent runs?**
Use `--fast` for simple tasks, keep tasks scoped (`--cwd` to the project), rely on the workspace snapshot instead of asking the agent to explore, raise `--steps` only when a task genuinely needs it, and set `aiFallbacks` so a rate-limited provider doesn't stall the loop.
