# ⚡ gitmancer

**Zero-dependency AI CLI agent for your code & your whole GitHub account.**

Give it any OpenAI-compatible AI key (Groq / OpenAI / OpenRouter / Z.ai / Ollama / custom) plus a
GitHub token, and it becomes a terminal-native agent that reads and writes your code, runs
commands, commits, pushes, creates repos, and manages issues — you talk, it ships.

![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![deps](https://img.shields.io/badge/dependencies-0-blue) ![license](https://img.shields.io/badge/license-MIT-orange)

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

## Why

Existing AI CLIs lock you into one provider, need `npm install` rituals, or stop at your
local machine. **gitmancer** is one file, zero dependencies, provider-agnostic, and reaches
all the way to your GitHub account — code, commits, repos, issues — through the same two
keys you already have.

## Install

**Option A — single file (no install):**

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
| `gitmancer ask "<task>"` | **the agent** — explores code, edits files, runs commands, calls GitHub |
| `gitmancer ask --chat` | same, but stays in an interactive conversation |
| `gitmancer ship ["msg"]` | stage all, AI-generated commit message (if omitted), push |
| `gitmancer newrepo <name>` | create a GitHub repo via API; `--source .` also init + commit + push |
| `gitmancer issue <owner/repo> …` | `list` · `create "Title" --body "…"` · `close 12` |

**Useful flags:** `--yolo` (skip confirmations for unattended runs) · `--private` · `--limit N` · `--cwd <dir>`

### The agent loop

`ask` gives the model five tools and lets it drive:

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

Env-var overrides (CI-friendly): `GITMANCER_AI_KEY`, `GITMANCER_AI_BASE`, `GITMANCER_AI_MODEL`,
`GITMANCER_GITHUB_TOKEN`, `GITMANCER_GH_BASE` (also handy for GitHub Enterprise).

## Security

- Tokens live **only** in `~/.gitmancer/config.json` (`chmod 600`) or env vars.
- `gitmancer config` masks secrets; `git push` output is token-redacted.
- The system prompt forbids the model from writing keys into files, commands, or logs.
- Push uses your existing git credentials for `ship`; the one-shot tokened URL in `newrepo`
  is never stored in `.git/config`.
- Recommend **fine-grained PATs** scoped to just the repos you need — revoke anytime.

## Roadmap

- [ ] `gitmancer pr` — AI-reviewed pull requests (diff → review comment → merge)
- [ ] scheduled farming mode: commit queues + planned pushes
- [ ] repo templates: `newrepo --template node-lib` scaffolds + pushes a full project
- [ ] multi-repo sweeps: "bump version + changelog + push" across all repos
- [ ] `--json` output mode for scripting

## Contributing

PRs welcome — keep it zero-dependency, that's the whole point. `npm test` runs the mock
end-to-end suite (no keys needed).

## License

MIT
