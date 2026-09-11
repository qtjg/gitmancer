# Contributing to gitmancer

Thanks for helping make gitmancer faster and more effective. This project stays
deliberately small: **one file, zero dependencies, Node 18+**. Keep that spirit
in mind for every change.

## Ground rules

1. **Zero dependencies.** Node's standard library plus built-in `fetch` only.
   If a feature truly needs more, propose it in an issue first.
2. **Single file.** Everything lives in `gitmancer.js`. Sections are marked
   with `/* ---- section ---- */` banners — keep related code together.
3. **Safety first.** Anything that mutates the workspace or calls mutating
   GitHub endpoints must go through the confirmation gate (`allow()`), with
   `--yolo` as the only opt-out. Never log, print, or persist tokens/keys.
4. **Test what you ship.** The e2e suite (`test/mock.e2e.js`) spins a mock AI
   server + mock GitHub API and drives the real CLI. Add checks for new
   behavior there. Note the mock lives in-process, so CLI invocations must be
   spawned async, never `spawnSync`.

## Workflow

```sh
git clone https://github.com/qtjg/gitmancer && cd gitmancer
node --check gitmancer.js        # syntax gate
node test/mock.e2e.js            # e2e gate (must be 100% pass)
```

- Branch from `main`, use conventional commits
  (`feat|fix|perf|docs|test|chore|ci: summary ≤ 72 chars`).
- One logical change per commit — granular history is a feature here.
- Update `README.md` and the in-CLI `help()` whenever flags/commands change.
- Update `CHANGELOG.md` under **Unreleased**.
- Open a PR using the template; CI runs the matrix (node 18/20/22).

## Reporting bugs

Run `gitmancer doctor` first — it diagnoses config, keys, endpoints, and
fallbacks while masking your secrets. Attach its output to the issue.

## Security

See [SECURITY.md](SECURITY.md). Please do not open public issues for
vulnerabilities involving token handling or the confirmation gate.
