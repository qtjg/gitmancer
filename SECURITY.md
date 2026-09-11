# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.3.x   | ✅        |
| < 0.3   | ❌ upgrade |

## Reporting a vulnerability

Open a **private** security advisory via GitHub (Security → Advisories → New
draft security advisory) on `qtjg/gitmancer`. Do **not** open a public issue.

Include: affected command/flag, environment (Node/OS), and a minimal
reproduction. You'll get a response within a few days.

## Design invariants (treat violations as vulnerabilities)

1. **Secrets at rest** — tokens/keys live only in `~/.gitmancer/config.json`
   (chmod 600) or env vars. Nothing else may read, persist, or transmit them.
2. **Secrets in output** — every code path that can echo git/API output must
   redact via `redact()`. Tests assert tokens never reach stdout/stderr.
3. **Confirmation gate** — workspace writes, shell commands, and mutating
   GitHub calls require explicit user approval unless `--yolo` was passed for
   that invocation. The allowlist (`SAFE_CMD_RE`) is read-only commands only.
4. **Path containment** — workspace tools must refuse paths resolving outside
   the workspace root (`safePath`).
5. **No telemetry.** Nothing is sent anywhere except the AI provider you
   configured and api.github.com.
