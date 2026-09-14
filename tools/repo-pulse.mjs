#!/usr/bin/env node
// ⬡ repo-pulse — zero-dependency git activity pulse for any repo
// made by Mayank Bhaskar · https://github.com/qtjg
// usage: node tools/repo-pulse.mjs
import { execSync } from "node:child_process";

const g = (cmd) => { try { return execSync(`git ${cmd}`, { encoding: "utf8" }); } catch { return ""; } };

if (!g("rev-parse --git-dir").trim()) {
  console.log("repo-pulse: not inside a git repository");
  process.exit(1);
}

const branch = g("rev-parse --abbrev-ref HEAD").trim();
const head = g("rev-parse --short HEAD").trim();
const dirty = !!g("status --porcelain").trim();
const since = new Date(Date.now() - 27 * 864e5).toISOString().slice(0, 10);

const days = {};
for (const d of g(`log --since=${since} --pretty=format:%ad --date=short`).split("\n")) {
  const k = d.trim(); if (k) days[k] = (days[k] || 0) + 1;
}
const files = {};
for (const f of g(`log --since=${since} --name-only --pretty=format:`).split("\n")) {
  const k = f.trim(); if (k) files[k] = (files[k] || 0) + 1;
}
const authors = {};
for (const a of g(`log --since=${since} --pretty=format:%an`).split("\n")) {
  const k = a.trim(); if (k) authors[k] = (authors[k] || 0) + 1;
}

const total = Object.values(days).reduce((a, b) => a + b, 0);
let bar = "";
for (let i = 27; i >= 0; i--) {
  const k = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
  bar += days[k] ? "█" : "·";
}
const peak = Object.entries(days).sort((a, b) => b[1] - a[1])[0];
const topFiles = Object.entries(files).sort((a, b) => b[1] - a[1]).slice(0, 5);
const topAuthors = Object.entries(authors).sort((a, b) => b[1] - a[1]).slice(0, 3);

console.log(`⬡ repo-pulse · branch ${branch} @ ${head}${dirty ? " · dirty tree" : " · clean"}`);
console.log(`  ${String(total).padStart(4)} commits / 28d   ${bar}`);
if (peak) console.log(`  peak day: ${peak[0]} (${peak[1]} commits)`);
if (topFiles.length) {
  console.log("  hot files:");
  for (const [f, n] of topFiles) console.log(`    ${String(n).padStart(3)}x  ${f.slice(0, 72)}`);
}
if (topAuthors.length) {
  console.log(`  contributors: ${Object.keys(authors).length} — ` +
    topAuthors.map(([a, n]) => `${a} (${n})`).join(", "));
}
