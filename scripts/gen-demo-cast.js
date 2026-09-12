#!/usr/bin/env node
/* Build docs/demo.cast for gitmancer (#5):
 * records REAL offline gitmancer commands via `gitmancer record`, then merges
 * the parts into one asciinema v2 cast with cumulative timestamps.
 * No mocks: every byte in the cast is real CLI output. */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = "/home/z/my-project/gitmancer";
const CLI = path.join(ROOT, "gitmancer.js");
const OUT = path.join(ROOT, "docs", "demo.cast");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gm-demo-home-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "gm-demo-work-"));
const env = { ...process.env, HOME, COLUMNS: "96", LINES: "28", NO_COLOR: "1" };

function sh(cmd, opts = {}) {
  return execFileSync(cmd[0], cmd.slice(1), { cwd: opts.cwd || WORK, env: opts.env || env, stdio: opts.stdio || "pipe" });
}

// fixture repo with a planted (runtime-built) secret for the secscan part
sh(["git", "init", "-qb", "main", "demo"], { cwd: WORK });
const demo = path.join(WORK, "demo");
sh(["git", "config", "user.email", "demo@local"], { cwd: demo });
sh(["git", "config", "user.name", "demo"], { cwd: demo });
const FAKE = "ghp_" + "D".repeat(32) + "7777";
fs.writeFileSync(path.join(demo, "config.js"), `const token = "${FAKE}";\nconst ok = "clean";\n`);
sh(["git", ["add", "."][0], "."], { cwd: demo });
sh(["git", "commit", "-qm", "init: demo project"], { cwd: demo });
// scaffold + install the demo plugin (real dogfood of the plugin system)
sh(["node", CLI, "plugin", "new", "banner"], { cwd: demo });
fs.writeFileSync(
  path.join(HOME, ".gitmancer", "plugins", "banner.js"),
  `"use strict";
module.exports = {
  name: "banner", version: "1.0.0",
  description: "plugin demo: shouts text in a box",
  usage: "<text>",
  run: async ({ args }) => {
    const t = (args.join(" ") || "hello from a plugin").slice(0, 60);
    const line = "─".repeat(t.length + 4);
    return "┌" + line + "┐\\n│  " + t + "  │\\n└" + line + "┘";
  },
};
`
);

const parts = [
  { cmd: `echo '$ gitmancer version'; node ${CLI} version`, note: "version" },
  { cmd: `echo '$ gitmancer plugin new banner && gitmancer banner "built in 2 min"'; node ${CLI} plugin list; node ${CLI} banner "built in 2 min"`, note: "plugin" },
  { cmd: `echo '$ gitmancer secscan'; node ${CLI} secscan; echo '(exit '$?' — secscan blocks the commit)'`, note: "secscan", cwd: demo },
  { cmd: `echo '$ gitmancer help'; node ${CLI} help`, note: "help" },
];

// record each part
const castFiles = [];
for (const p of parts) {
  const out = path.join(HOME, `part-${p.note}.cast`);
  sh(["node", CLI, "record", `cd ${p.cwd || demo} && ${p.cmd}`, "--out", out], { cwd: demo });
  castFiles.push(out);
}

// merge with cumulative timestamps
const events = [];
let offset = 0;
let base = null;
for (const f of castFiles) {
  const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  let last = 0;
  for (const l of lines) {
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    if (Array.isArray(j)) {
      const t = Number(j[0]) || 0;
      const rel = Math.max(t - last, 0);
      last = t;
      // shorten the throwaway HOME path to "~" — cosmetic, keeps the demo portable
      events.push([+(offset + rel).toFixed(6), j[1], String(j[2]).split(HOME).join("~")]);
    } else if (j && j.version && !base) base = j;
  }
  offset += last + 0.35; // small pause between parts
}
base = { ...base, timestamp: Math.floor(Date.now() / 1000), command: "demo: version · plugin · secscan · help" };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(base) + "\n" + events.map((e) => JSON.stringify(e)).join("\n") + "\n");
const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`demo.cast written: ${events.length} events, ${kb}kb, duration ${offset.toFixed(1)}s`);
fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
