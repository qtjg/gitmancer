#!/usr/bin/env node
"use strict";
/*
 * gitmancer — zero-dependency AI CLI agent for your code & your whole GitHub account.
 * Any OpenAI-compatible AI key (Groq/OpenAI/OpenRouter/Z.ai/Ollama/custom) + a GitHub token
 * = an agent that reads/writes code, runs commands, commits, pushes, creates repos,
 * manages issues/PRs — straight from your terminal.
 *
 * MIT License. https://github.com/gitmancer
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");

const VERSION = "0.5.0";
const NAME = "gitmancer";
const UA = `${NAME}/${VERSION}`;
const CONFIG_DIR = path.join(os.homedir(), ".gitmancer");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const GH_API_DEFAULT = "https://api.github.com";
const MAX_STEPS = 25;

class UserErr extends Error {}

/* ---------------- output helpers ---------------- */

const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
let FORCE_COLOR_OFF = false;
const paint = (code, s) => (TTY && !FORCE_COLOR_OFF ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = (s) => paint("1", s);
const dim = (s) => paint("2", s);
const green = (s) => paint("32", s);
const yellow = (s) => paint("33", s);
const red = (s) => paint("31", s);
const cyan = (s) => paint("36", s);
const magenta = (s) => paint("35", s);

const ok = (...a) => console.log(green("✔"), ...a);
const warn = (...a) => console.log(yellow("▲"), ...a);
const fail = (...a) => console.error(red("✖"), ...a);
const info = (...a) => console.log(cyan("ℹ"), ...a);

function banner() {
  console.log(magenta(`\n⚡ ${NAME} ${dim("v" + VERSION)} — AI agent for your code & your whole GitHub account\n`));
}

function capOut(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n) + `\n…(+${s.length - n} chars truncated)` : s;
}

function mask(s) {
  return s ? dim("••••••" + s.slice(-4)) : dim("(not set)");
}

function redact(str, ...secrets) {
  let out = String(str == null ? "" : str);
  for (const sec of secrets) {
    if (sec) out = out.split(sec).join("***");
  }
  return out;
}

/* ---------------- input helpers ---------------- */

let _rl = null;
let _stdinClosed = false;
function rl() {
  if (!_rl) {
    _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    _rl.on("SIGINT", () => {
      console.log(dim("\nbye ⚡"));
      process.exit(0);
    });
    _rl.on("close", () => {
      _stdinClosed = true;
    });
  }
  return _rl;
}

function askUser(q) {
  const r = rl();
  return new Promise((res) => {
    if (_stdinClosed) return res(null);
    const onClose = () => res(null);
    r.once("close", onClose);
    r.question(q, (a) => {
      r.removeListener("close", onClose);
      res(a);
    });
  });
}

/* ---------------- config ---------------- */

const PRESETS = {
  groq: { base: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", fast: "llama-3.1-8b-instant" },
  openai: { base: "https://api.openai.com/v1", model: "gpt-4o-mini", fast: "gpt-4o-mini" },
  openrouter: { base: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", fast: "meta-llama/llama-3.1-8b-instant" },
  zai: { base: "https://api.z.ai/api/paas/v4", model: "glm-4.6", fast: "glm-4-flash" },
  ollama: { base: "http://127.0.0.1:11434/v1", model: "llama3.1", fast: "llama3.2" },
};

function loadConfig() {
  let fileCfg = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    warn(`could not parse ${CONFIG_FILE} (${e.message}) — using env/defaults`);
  }
  return {
    preset: fileCfg.preset || "groq",
    aiBase: process.env.GITMANCER_AI_BASE || fileCfg.aiBase || PRESETS.groq.base,
    aiModel: process.env.GITMANCER_AI_MODEL || fileCfg.aiModel || PRESETS.groq.model,
    aiKey: process.env.GITMANCER_AI_KEY || fileCfg.aiKey || "",
    githubToken: process.env.GITMANCER_GITHUB_TOKEN || fileCfg.githubToken || "",
    ghBase: process.env.GITMANCER_GH_BASE || fileCfg.ghBase || GH_API_DEFAULT,
    aiFallbacks: Array.isArray(fileCfg.aiFallbacks) ? fileCfg.aiFallbacks : [],
  };
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {}
}

/* ---------------- GitHub API client (GET cache + redaction) ---------------- */

const GH_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const _ghCache = new Map(); // method+endpoint → { t, data }

function ghCacheGet(key) {
  const e = _ghCache.get(key);
  if (e && Date.now() - e.t < GH_CACHE_TTL) return e.data;
  _ghCache.delete(key);
  return null;
}

function ghCacheSet(key, data) {
  _ghCache.set(key, { t: Date.now(), data });
}

function ghCacheClear() {
  _ghCache.clear();
}
const _ghInflight = new Map(); // coalesce identical in-flight GETs → one HTTP request

async function gh(cfg, method, endpoint, body, opts = {}) {
  method = String(method).toUpperCase();
  const cacheable = method === "GET" && opts.cache !== false;
  const ckey = method + " " + endpoint;
  if (cacheable) {
    const hit = ghCacheGet(ckey);
    if (hit !== null) return hit;
    const pending = _ghInflight.get(ckey);
    if (pending) return pending; // identical concurrent GETs share one request
  }
  const p = ghSend(cfg, method, endpoint, body, opts, cacheable, ckey);
  if (!cacheable) return p;
  _ghInflight.set(ckey, p);
  try {
    return await p;
  } finally {
    _ghInflight.delete(ckey);
  }
}

async function ghSend(cfg, method, endpoint, body, opts = {}, cacheable = false, ckey = "") {
  if (!cfg.githubToken) {
    throw new UserErr("No GitHub token. Run `gitmancer setup` or export GITMANCER_GITHUB_TOKEN.");
  }
  method = method.toUpperCase();
  const url = endpoint.startsWith("http") ? endpoint : cfg.ghBase.replace(/\/$/, "") + endpoint;
  let res;
  try {
    res = await fetch(url, {
      method: method.toUpperCase(),
      headers: {
        Authorization: `Bearer ${cfg.githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": UA,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new UserErr(`GitHub request failed: ${e.message} (check network / GITMANCER_GH_BASE)`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data && data.message) || capOut(text, 200);
    let hint = "";
    if (res.status === 401) hint = " — token invalid/expired (make a fine-grained PAT)";
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") hint = " — rate limit exhausted, try later";
    if (res.status === 404) hint = " — not found (check repo name / token scopes)";
    if (res.status === 422 && data && data.errors) hint = " — " + JSON.stringify(data.errors).slice(0, 200);
    throw new UserErr(`GitHub ${res.status}: ${msg}${hint}`);
  }
  if (cacheable) ghCacheSet(ckey, data);
  else ghCacheClear(); // any successful mutation invalidates cached reads
  return data;
}

async function ghPaginate(cfg, endpoint, limit = 200) {
  const out = [];
  const sep = endpoint.includes("?") ? "&" : "?";
  for (let page = 1; out.length < limit; page++) {
    const chunk = await gh(cfg, "GET", `${endpoint}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(chunk) || !chunk.length) break;
    out.push(...chunk);
    if (chunk.length < 100) break;
  }
  return out.slice(0, limit);
}

/* ---------------- AI client (OpenAI-compatible, SSE streaming + retry + fallback) ---------------- */

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, init, label, retries = 2) {
  let attempt = 0;
  for (;;) {
    let res = null;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (attempt >= retries) throw new UserErr(`${label} request failed: ${e.message}`);
    }
    if (res && !RETRYABLE_STATUS.has(res.status)) return res;
    if (res && attempt >= retries) return res; // give up — caller surfaces the HTTP error
    const ra = res ? parseInt(res.headers.get("retry-after") || "", 10) : NaN;
    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 8000) : 400 * 2 ** attempt + Math.floor(Math.random() * 250);
    if (res && res.body && res.body.resume) {
      try {
        res.body.resume();
      } catch {}
    }
    attempt += 1;
    await sleep(wait);
  }
}

function sseAccumulator(onDelta) {
  const state = { content: "", calls: {}, finish: null, streamed: false };
  const feed = (raw) => {
    const line = raw.trim();
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let j;
    try {
      j = JSON.parse(payload);
    } catch {
      return;
    }
    const ch = j.choices && j.choices[0];
    if (!ch) return;
    const d = ch.delta || {};
    if (d.content) {
      state.content += d.content;
      state.streamed = true;
      if (onDelta) onDelta(d.content);
    }
    if (d.tool_calls) {
      for (const tc of d.tool_calls) {
        const i = tc.index || 0;
        if (!state.calls[i]) state.calls[i] = { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) state.calls[i].id = tc.id;
        if (tc.function && tc.function.name) state.calls[i].function.name += tc.function.name;
        if (tc.function && tc.function.arguments) state.calls[i].function.arguments += tc.function.arguments;
      }
    }
    if (ch.finish_reason) state.finish = ch.finish_reason;
  };
  return {
    get message() {
      const ids = Object.keys(state.calls).sort((a, b) => a - b);
      const message = { role: "assistant", content: state.content };
      if (ids.length) message.tool_calls = ids.map((i) => state.calls[i]);
      return message;
    },
    get streamed() {
      return state.streamed;
    },
    async consume(res) {
      const decoder = new TextDecoder();
      let buf = "";
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          feed(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      }
      if (buf.trim()) feed(buf);
      if (!state.content && !Object.keys(state.calls).length) {
        throw new UserErr("AI stream ended without content (check model name / provider support)");
      }
    },
  };
}

/* ---------------- usage metering ---------------- */

const USAGE = { calls: 0, prompt: 0, completion: 0, est: 0 };
const estTokens = (s) => Math.ceil((s || "").length / 4);
function recordUsage(messages, reply, usage) {
  USAGE.calls++;
  if (usage && Number.isFinite(usage.prompt_tokens)) {
    USAGE.prompt += usage.prompt_tokens;
    USAGE.completion += usage.completion_tokens || 0;
  } else {
    USAGE.est++;
    USAGE.prompt += estTokens(JSON.stringify(messages || []));
    USAGE.completion += estTokens(reply && reply.content);
  }
}
function usageLine() {
  const tot = USAGE.prompt + USAGE.completion;
  return `usage: ${USAGE.calls} AI call${USAGE.calls === 1 ? "" : "s"} · ~${tot} tokens (${USAGE.prompt} in / ${USAGE.completion} out${USAGE.est ? ", estimated" : ""})`;
}

async function aiChat(cfg, messages, tools, opts = {}) {
  const chain = [{ aiBase: cfg.aiBase, aiModel: cfg.aiModel, aiKey: cfg.aiKey }];
  for (const fb of cfg.aiFallbacks || []) {
    if (fb && fb.base && fb.model) chain.push({ aiBase: fb.base, aiModel: fb.model, aiKey: fb.key || cfg.aiKey });
  }
  let lastErr;
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i];
    try {
      const r = await aiChatProvider({ ...cfg, aiBase: c.aiBase, aiModel: c.aiModel, aiKey: c.aiKey }, messages, tools, opts);
      if (i > 0) console.error(dim(`  ↪ served by fallback #${i} (${c.aiModel})`));
      return r;
    } catch (e) {
      lastErr = e;
      if (i + 1 < chain.length) console.error(yellow(`  ↪ ${String(e.message).slice(0, 160)} — trying fallback (${chain[i + 1].aiModel})`));
    }
  }
  throw lastErr;
}

async function aiChatProvider(cfg, messages, tools, opts = {}) {
  const isLocal = /localhost|127\.0\.0\.1/.test(cfg.aiBase);
  if (!cfg.aiKey && !isLocal) {
    throw new UserErr("No AI key. Run `gitmancer setup` or export GITMANCER_AI_KEY.");
  }
  const url = cfg.aiBase.replace(/\/$/, "") + "/chat/completions";
  const headers = {
    "Content-Type": "application/json",
    ...(cfg.aiKey ? { Authorization: `Bearer ${cfg.aiKey}` } : {}),
  };
  const payload = { model: cfg.aiModel, messages, temperature: 0.2 };
  if (tools && tools.length) payload.tools = tools;
  if (opts.stream) payload.stream = true;
  const req = { method: "POST", headers, body: JSON.stringify(payload) };
  let res = await fetchRetry(url, req, "AI");
  if (opts.stream) {
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (res.ok && ctype.includes("text/event-stream")) {
      const acc = sseAccumulator(opts.onDelta);
      await acc.consume(res);
      recordUsage(messages, acc.message, null);
      return { message: acc.message, streamed: acc.streamed };
    }
    if (!res.ok) res = await fetchRetry(url, req, "AI", 0); // provider may not support streaming — retry buffered once
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UserErr(`AI returned non-JSON (HTTP ${res.status}): ${capOut(text, 300)}`);
  }
  if (!res.ok) {
    const m = (json.error && json.error.message) || capOut(text, 300);
    throw new UserErr(`AI HTTP ${res.status}: ${m}`);
  }
  const choice = json.choices && json.choices[0];
  if (!choice || !choice.message) throw new UserErr(`AI returned no choices: ${capOut(text, 300)}`);
  recordUsage(messages, choice.message, json.usage || null);
  return { message: choice.message, streamed: false };
}

/* ---------------- agent tools ---------------- */

function t(name, description, properties, required) {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required: required || [] } },
  };
}

const TOOLS = [
  t("list_files", "List files and folders under a path in the user's workspace. Always explore before editing.", {
    path: { type: "string", description: "Relative path from workspace root (default '.')" },
  }),
  t("read_file", "Read a text file from the workspace. For large files pass offset/limit to page through it (1-based lines).", {
    path: { type: "string", description: "Relative file path" },
    offset: { type: "number", description: "First line to return (1-based). Default 1." },
    limit: { type: "number", description: "Max lines to return. Default: whole file (capped at 2000 lines)." },
  }, ["path"]),
  t("write_file", "Create or overwrite a file in the workspace with full content.", {
    path: { type: "string", description: "Relative file path" },
    content: { type: "string", description: "Complete file content to write" },
  }, ["path", "content"]),
  t("batch_edit", "Make several exact string replacements inside one file in a single call (cheaper than rewriting the whole file). Each 'find' must occur exactly once unless replace_all is set.", {
    path: { type: "string", description: "Relative file path" },
    edits: { type: "array", description: "Replacements applied in order", items: { type: "object", properties: { find: { type: "string", description: "Exact text to find" }, replace: { type: "string", description: "Replacement text" }, replace_all: { type: "boolean", description: "Replace every occurrence (default false = must match exactly once)" } }, required: ["find", "replace"] } },
  }, ["path", "edits"]),
  t("run_cmd", "Run a shell command in the workspace (git, npm, tests, builds, ls, etc.) and get combined stdout+stderr.", {
    command: { type: "string", description: "The shell command to run" },
    timeout_ms: { type: "number", description: "Timeout in milliseconds (default 120000, max 600000). Long installs/builds: 300000." },
  }, ["command"]),
  t("github_api", "Call the GitHub REST API to manage the user's account: repos, issues, pull requests, gists, releases, stars, profile. Use paths like '/user/repos'.", {
    method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
    endpoint: { type: "string", description: "API path, e.g. /repos/owner/name/issues" },
    body: { type: "object", description: "JSON request body for POST/PATCH/PUT" },
  }, ["method", "endpoint"]),
];

function safePath(cwd, p) {
  const abs = path.resolve(cwd, p || ".");
  if (abs !== cwd && !abs.startsWith(cwd + path.sep)) throw new UserErr(`Path escapes workspace: ${p}`);
  return abs;
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "__pycache__", ".next", "venv", ".venv", ".cache"]);

function loadIgnorePatterns(cwd) {
  const pats = new Set(IGNORE_DIRS);
  try {
    const gi = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
    for (let line of gi.split("\n")) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      pats.add(line.replace(/^\//, "").replace(/\/$/, ""));
    }
  } catch {}
  return pats;
}

function toolListFiles(cwd, rel) {
  const root = safePath(cwd, rel || ".");
  const out = [];
  const ignored = loadIgnorePatterns(cwd);
  const isIgnored = (name) => {
    if (ignored.has(name)) return true;
    for (const p of ignored) {
      if (p.endsWith("*") && name.startsWith(p.slice(0, -1))) return true; // build*
      if (p.startsWith("*.") && name.endsWith(p.slice(1))) return true; // *.log
    }
    return false;
  };
  const walk = (dir, depth) => {
    if (depth > 4 || out.length > 400) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      out.push(`(cannot read ${dir}: ${e.message})`);
      return;
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (out.length > 400) {
        out.push("…(truncated)");
        return;
      }
      if (e.name.startsWith(".") && e.name !== ".github" && e.name !== ".env.example") continue;
      if (isIgnored(e.name)) continue;
      const rel2 = path.join(path.relative(cwd, dir), e.name);
      if (e.isDirectory()) {
        out.push(rel2 + "/");
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        let size = "";
        try {
          size = ` (${fs.statSync(path.join(dir, e.name)).size}b)`;
        } catch {}
        out.push(rel2 + size);
      }
    }
  };
  walk(root, 0);
  return out.length ? out.join("\n") : "(empty directory)";
}

const SAFE_CMD_RE = /^\s*(ls|pwd|cat|head|tail|wc|file|which|git status|git log\b|git diff|git branch|git remote|git show|node --version|npm --version|npx tsc --version|python3? --version|echo\s)/;

function shortArgs(args) {
  try {
    return capOut(JSON.stringify(args), 140);
  } catch {
    return "(args)";
  }
}

function runShell(command, cwd, timeoutMs) {
  const r = spawnSync(command, {
    shell: true,
    cwd,
    encoding: "utf8",
    timeout: timeoutMs || 120000,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.error && r.error.killed) return { code: r.status, out: "", error: "timeout" };
  let out = ((r.stdout || "") + (r.stderr || "")).trim();
  if (r.error) out += `\n(process error: ${r.error.message})`;
  return { code: r.status, out: capOut(out, 8000) };
}

async function allow(desc, ctx) {
  if (ctx.yolo || ctx.always.value) return true;
  if (SAFE_CMD_RE.test(desc)) {
    console.log(dim(`  ⚙ ${desc}`));
    return true;
  }
  const ans = ((await askUser(`${yellow("allow")} ${bold(desc)} ${dim("[y/N/a]")} `)) ?? "").trim().toLowerCase();
  if (ans === "a" || ans === "always") {
    ctx.always.value = true;
    return true;
  }
  return ans === "y" || ans === "yes";
}

async function runTool(name, args, ctx) {
  const cwd = ctx.cwd;
  try {
    switch (name) {
      case "list_files":
        return toolListFiles(cwd, args.path || ".");

      case "read_file": {
        const abs = safePath(cwd, args.path);
        const raw = capOut(fs.readFileSync(abs, "utf8"), 20000);
        const lines = raw.split("\n");
        const off = Math.max(parseInt(args.offset, 10) || 1, 1);
        const lim = Math.min(Math.max(parseInt(args.limit, 10) || 2000, 1), 2000);
        const slice = lines.slice(off - 1, off - 1 + lim);
        const head = `lines ${off}-${off - 1 + slice.length} of ${lines.length}`;
        return (slice.length === lines.length && off === 1 ? raw : `[${head}]\n` + slice.join("\n"));
      }

      case "write_file": {
        const abs = safePath(cwd, args.path);
        const rel = path.relative(cwd, abs);
        if (!(await allow(`write ${rel} (${Buffer.byteLength(String(args.content || ""))} bytes)`, ctx))) {
          return "DENIED by user — do not retry this same write; propose an alternative.";
        }
        pushUndo({ type: "file", file: abs, prev: fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null });
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(args.content == null ? "" : args.content));
        return `OK — wrote ${rel} (${fs.statSync(abs).size} bytes)`;
      }

      case "batch_edit": {
        const abs = safePath(cwd, args.path);
        const rel = path.relative(cwd, abs);
        const edits = Array.isArray(args.edits) ? args.edits : [];
        if (!edits.length) return "ERROR: edits[] is empty";
        let src;
        try {
          src = fs.readFileSync(abs, "utf8");
        } catch {
          return `ERROR: cannot read ${rel} — use write_file to create it first`;
        }
        for (let i = 0; i < edits.length; i++) {
          const find = edits[i] && edits[i].find;
          const replace = edits[i] && edits[i].replace;
          if (typeof find !== "string" || !find) return `ERROR: edits[${i}].find must be a non-empty string; nothing changed`;
          const n = src.split(find).length - 1;
          if (n === 0) return `ERROR: edits[${i}] — \`${capOut(find, 60)}\` not found in ${rel}; nothing changed`;
          if (n > 1 && !(edits[i] && edits[i].replace_all)) return `ERROR: edits[${i}] — \`${capOut(find, 60)}\` occurs ${n} times in ${rel}; pass replace_all:true or a longer unique string`;
          const rep = String(replace == null ? "" : replace);
          src = edits[i] && edits[i].replace_all ? src.split(find).join(rep) : src.replace(find, rep);
        }
        if (!(await allow(`batch-edit ${rel} (${edits.length} replacement${edits.length === 1 ? "" : "s"})`, ctx))) {
          return "DENIED by user — do not retry this same edit; propose an alternative.";
        }
        pushUndo({ type: "file", file: abs, prev: fs.readFileSync(abs, "utf8") });
        fs.writeFileSync(abs, src);
        return `OK — ${edits.length} replacement${edits.length === 1 ? "" : "s"} applied to ${rel}`;
      }

      case "run_cmd": {
        const command = String(args.command || "").trim();
        if (!command) return "ERROR: empty command";
        if (!(await allow(`run \`${command}\``, ctx))) {
          return "DENIED by user — do not retry this same command; propose an alternative.";
        }
        const maxMs = Math.min(parseInt(process.env.GITMANCER_CMD_TIMEOUT, 10) || 120000, 600000);
        const tMs = Math.min(Math.max(parseInt(args.timeout_ms, 10) || maxMs, 1000), 600000);
        const r = runShell(command, cwd, tMs);
        if (r.error === "timeout") return `ERROR: command timed out after ${tMs}ms — it was killed. Narrow the scope or raise timeout_ms.`;
        return `exit ${r.code}\n${r.out || "(no output)"}`;
      }

      case "github_api": {
        const method = String(args.method || "GET").toUpperCase();
        const endpoint = String(args.endpoint || "");
        if (!endpoint) return "ERROR: missing endpoint";
        const desc = `GITHUB ${method} ${endpoint}`;
        if (method !== "GET" && !(await allow(desc, ctx))) {
          return "DENIED by user — do not retry this same call; propose an alternative.";
        }
        const data = await gh(ctx.cfg, method, endpoint, args.body, { cache: !ctx.noCache });
        return capOut(typeof data === "string" ? data : JSON.stringify(data, null, 2), 6000);
      }

      default:
        return `ERROR: unknown tool "${name}"`;
    }
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

/* ---------------- agent loop ---------------- */

function pushUndo(rec) {
  try {
    const f = path.join(CONFIG_DIR, "undo-journal.jsonl");
    let lines = [];
    try { lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean); } catch {}
    lines.push(JSON.stringify({ at: new Date().toISOString(), ...rec }));
    if (lines.length > 200) lines = lines.slice(-150);
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(f, lines.join("\n") + "\n");
  } catch {}
}

function loadMemory(cwd) {
  try {
    const txt = fs.readFileSync(path.join(cwd, "GITMANCER.md"), "utf8").trim();
    return txt ? capOut(txt, 1600) : null;
  } catch {
    return null;
  }
}


function buildSnapshot(cwd) {
  const parts = [];
  try {
    const tree = toolListFiles(cwd, ".").split("\n");
    const shown = tree.slice(0, 45);
    parts.push("Files:\n" + shown.join("\n") + (tree.length > 45 ? `\n…(+${tree.length - 45} more — use list_files)` : ""));
  } catch {}
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    parts.push(
      `package.json: ${pkg.name || "?"} v${pkg.version || "?"}` +
        (pkg.description ? ` — ${String(pkg.description).slice(0, 120)}` : "") +
        (pkg.scripts ? ` | scripts: ${Object.keys(pkg.scripts).join(", ")}` : "")
    );
  } catch {}
  try {
    const rd = fs.readFileSync(path.join(cwd, "README.md"), "utf8");
    if (rd.trim()) parts.push(`README (excerpt): ${capOut(rd.trim(), 500)}`);
  } catch {}
  try {
    const branch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    const last = gitOut(["log", "--oneline", "-1"], cwd);
    parts.push(`git: branch=${branch} | last commit: ${last}`);
  } catch {}
  return capOut(parts.join("\n\n"), 2400);
}

function systemPrompt(ctx) {
  const lines = [
    `You are ${NAME} v${VERSION}, an autonomous coding and GitHub agent running in the user's terminal.`,
    `Workspace (cwd): ${ctx.cwd}`,
    `OS: ${os.platform()} ${os.arch()} | Node ${process.version} | Date: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "Rules:",
    "- Inspect before you edit: list_files / read_file first, then make minimal, correct changes.",
    "- Use run_cmd for git operations (status, diff, add, commit, push) when the user asks to commit or push.",
    "- Use github_api for account-level actions: repos, issues, pull requests, gists, releases, stars.",
    "- Mutating tools prompt the user for approval unless they enabled yolo mode.",
    "- If something fails, read the error and try a reasonable fix; never repeat the exact same failing call more than twice.",
    "- When the task is complete, reply with a SHORT summary of what changed and a suggested next step.",
    "- Never print, log, or write the user's tokens or API keys anywhere. Never put tokens in file content or commands.",
  ];
  if (ctx.snapshot) {
    lines.push(
      "",
      "WORKSPACE SNAPSHOT (auto-generated just now — trust it; skip list_files/read_file when this already answers the question):",
      ctx.snapshot
    );
  }
  const mem = loadMemory(ctx.cwd);
  if (mem) {
    lines.push(
      "",
      "PROJECT MEMORY (GITMANCER.md in this repo — the user saved these rules for you; follow them exactly):",
      mem
    );
  }
  return lines.join("\n");
}

function trimHistory(messages, max = 80, keep = 40) {
  if (messages.length <= max) return;
  // Compaction v2: never break a tool_call↔tool pair. Only cut at safe
  // boundaries: keep system (index 0), keep the first real user task, then
  // drop the oldest middle block ending right before a user message.
  const firstUser = messages.findIndex((m, i) => i > 0 && m.role === "user");
  const headEnd = firstUser > 0 ? firstUser : 1;
  // find the last user message index whose suffix (from it to end) fits in `keep`
  let cut = -1;
  for (let i = messages.length - keep; i > headEnd; i--) {
    if (messages[i] && messages[i].role === "user") {
      cut = i;
      break;
    }
  }
  if (cut === -1) {
    // fallback: plain tail keep from the first safe user boundary
    for (let i = messages.length - 1; i > headEnd; i--) {
      if (messages[i] && messages[i].role === "user") {
        cut = i;
        break;
      }
    }
    if (cut === -1) return;
  }
  const dropped = cut - headEnd;
  if (dropped <= 0) return;
  const head = messages.slice(0, headEnd);
  const tail = messages.slice(cut);
  const stub = {
    role: "user",
    content: `[context compacted — ${dropped} earlier messages summarized away; the current task continues below]`,
  };
  messages.length = 0;
  messages.push(...head, stub, ...tail);
}

function applyFast(cfg, flags) {
  if (!flags || !flags.fast) return cfg;
  if (process.env.GITMANCER_AI_MODEL) return cfg; // explicit env model always wins
  const p = PRESETS[cfg.preset];
  if (p && p.fast && cfg.aiModel === p.model) return { ...cfg, aiModel: p.fast, __fast: true };
  return cfg;
}

function mkCtx(flags, cfg) {
  const ctx = {
    cwd: path.resolve((flags && flags.cwd) || process.cwd()),
    yolo: !!(flags && flags.yolo),
    noCache: !!(flags && flags["no-cache"]),
    maxSteps: Math.min(Math.max(parseInt(flags && flags.steps, 10) || MAX_STEPS, 1), 100),
    budget: Math.max(parseInt(flags && flags.budget, 10) || 0, 0),
    always: { value: false },
    cfg,
  };
  try {
    ctx.snapshot = buildSnapshot(ctx.cwd);
  } catch {}
  return ctx;
}

async function agentTurn(cfg, messages, ctx) {
  for (let step = 0; step < (ctx.maxSteps || MAX_STEPS); step++) {
    if (ctx.budget && USAGE.prompt + USAGE.completion > ctx.budget) {
      warn(`--budget reached (~${USAGE.prompt + USAGE.completion} tokens) — stopping this run; re-run to continue`);
      return "budget";
    }
    let msg;
    let streamed = false;
    try {
      const r = await aiChat(cfg, messages, TOOLS, {
        stream: true,
        onDelta: (t) => process.stdout.write(t),
      });
      msg = r.message;
      streamed = r.streamed;
    } catch (e) {
      fail(e.message);
      return "error";
    }
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      if (streamed) process.stdout.write("\n\n");
      else console.log((msg.content || dim("(no answer)")) + "\n");
      messages.push({ role: "assistant", content: msg.content || "" });
      console.log(dim(usageLine()));
      return "done";
    }
    messages.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
    // Read-only tools (list_files / read_file / github_api GET) have no side effects
    // and never prompt — consecutive batches of them run concurrently. Mutating tools
    // stay sequential so confirmation order and filesystem effects remain deterministic.
    const parseTc = (tc) => {
      try {
        return JSON.parse((tc.function && tc.function.arguments) || "{}");
      } catch {
        return {};
      }
    };
    const isReadonly = (tc) => {
      const n = tc.function && tc.function.name;
      if (n === "list_files" || n === "read_file") return true;
      if (n === "github_api") {
        try {
          return String(parseTc(tc).method || "GET").toUpperCase() === "GET";
        } catch {
          return true;
        }
      }
      return false;
    };
    const groups = [];
    for (const tc of calls) {
      const ro = isReadonly(tc);
      const last = groups[groups.length - 1];
      if (ro && last && last.ro) last.calls.push(tc);
      else groups.push({ ro, calls: [tc] });
    }
    for (const g of groups) {
      if (g.ro && g.calls.length > 1) {
        for (const tc of g.calls) console.log(cyan(`\n⚙ ${tc.function.name}`) + dim(` ${shortArgs(parseTc(tc))} (parallel)`));
        const results = await Promise.all(g.calls.map((tc) => runTool(tc.function.name, parseTc(tc), ctx)));
        g.calls.forEach((tc, i) => {
          console.log(
            dim(
              capOut(results[i], 500)
                .split("\n")
                .map((l) => "  │ " + l)
                .join("\n")
            )
          );
          messages.push({ role: "tool", tool_call_id: tc.id, content: results[i] });
        });
      } else {
        const tc = g.calls[0];
        const name = tc.function && tc.function.name;
        const args = parseTc(tc);
        console.log(cyan(`\n⚙ ${name}`) + dim(` ${shortArgs(args)}`));
        const result = await runTool(name, args, ctx);
        console.log(
          dim(
            capOut(result, 500)
              .split("\n")
              .map((l) => "  │ " + l)
              .join("\n")
          )
        );
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    }
    trimHistory(messages);
  }
  warn(`stopped after ${ctx.maxSteps || MAX_STEPS} steps — continue with a follow-up message, or raise --steps`);
  console.log(dim(usageLine()));
  return "max_steps";
}

/* ---------------- commands ---------------- */

async function cmdSetup(flags) {
  banner();
  const existing = loadConfig();
  const presetName = String(flags.preset || flags[1] || "groq").toLowerCase();
  const preset = PRESETS[presetName];
  if (!preset && presetName !== "custom") {
    throw new UserErr(`Unknown preset "${presetName}". Options: ${Object.keys(PRESETS).join(" | ")}, custom`);
  }
  console.log(`provider: ${bold(presetName)}${preset ? dim(`  (${preset.base})`) : dim("  (custom endpoint)")}\n`);
  const base = flags.base || (preset ? preset.base : (await askUser("API base URL: ")));
  let model = flags.model || (preset ? preset.model : "");
  if (!model) model = await askUser("Default model: ");
  let aiKey = flags.key || "";
  if (!aiKey) {
    aiKey = ((await askUser(`AI API key ${existing.aiKey ? dim("(enter to keep ••••" + existing.aiKey.slice(-4) + ")") : ""}: `)) ?? "").trim() || existing.aiKey;
  }
  let ghToken = flags.token || "";
  if (!ghToken) {
    ghToken =
      ((await askUser(`GitHub token ${existing.githubToken ? dim("(enter to keep ••••" + existing.githubToken.slice(-4) + ")") : dim("(optional, for account features)")}: `)) ?? "").trim() ||
      existing.githubToken;
  }
  const cfg = {
    preset: presetName,
    aiBase: base,
    aiModel: model,
    aiKey,
    githubToken: ghToken,
    ghBase: flags.ghBase || existing.ghBase || GH_API_DEFAULT,
  };
  saveConfig(cfg);
  ok(`saved ${dim(CONFIG_FILE)} (chmod 600)`);
  console.log(`\nnext steps:
  ${cyan(`${NAME} whoami`)}                     ${dim("— verify your GitHub token")}
  ${cyan(`${NAME} ask "explain this repo"`)}    ${dim("— let the agent explore your code")}
  ${cyan(`${NAME} ship`)}                       ${dim("— AI commit message + push")}
  ${cyan(`${NAME} newrepo my-app --source .`)}  ${dim("— create repo & push a folder in one shot")}\n`);
}

function cmdConfig() {
  const cfg = loadConfig();
  banner();
  console.log(`config file : ${dim(CONFIG_FILE)} ${fs.existsSync(CONFIG_FILE) ? dim("(exists)") : dim("(missing — run setup)")}
ai provider  : ${bold(cfg.aiBase)}
ai model     : ${bold(cfg.aiModel)}
ai key       : ${mask(cfg.aiKey)}
github token : ${mask(cfg.githubToken)}
github api   : ${dim(cfg.ghBase)}
`);
}

async function cmdWhoami(flags) {
  const cfg = loadConfig();
  const u = await gh(cfg, "GET", "/user");
  if (flags && flags.json) {
    return console.log(JSON.stringify({ login: u.login, name: u.name, id: u.id, publicRepos: u.public_repos, privateRepos: u.total_private_repos, followers: u.followers, url: u.html_url }, null, 2));
  }
  console.log(`\n  ${bold("login     ")} ${cyan(u.login)}
  ${bold("name      ")} ${u.name || dim("—")}
  ${bold("repos     ")} ${u.public_repos} public${u.total_private_repos ? `, ${u.total_private_repos} private` : ""}
  ${bold("followers ")} ${u.followers}
  ${bold("url       ")} ${u.html_url}\n`);
}

async function cmdRepos(flags) {
  const cfg = loadConfig();
  const limit = parseInt(flags.limit, 10) || 50;
  const all = await ghPaginate(cfg, "/user/repos?sort=updated", limit);
  if (flags.json) {
    return console.log(
      JSON.stringify(
        all.slice(0, limit).map((r) => ({ name: r.full_name, private: !!r.private, language: r.language, stars: r.stargazers_count, pushed: (r.pushed_at || "").slice(0, 10), url: r.html_url })),
        null,
        2
      )
    );
  }
  if (!all.length) return ok("no repositories found");
  console.log(`\n${bold(all.length + " repos (most recently updated):")}\n`);
  for (const r of all.slice(0, limit)) {
    const vis = r.private ? yellow("[private]") : dim("[public]");
    const lang = r.language ? dim(r.language) : dim("—");
    const stars = r.stargazers_count ? `★${r.stargazers_count}` : "";
    const pushed = (r.pushed_at || "").slice(0, 10);
    console.log(`  ${bold(r.full_name)} ${vis} ${lang} ${stars ? cyan(stars) : ""} ${dim(pushed)}`);
  }
  console.log("");
}

async function cmdAsk(pos, flags) {
  const cfg = applyFast(loadConfig(), flags);
  if (cfg.__fast) console.log(dim(`fast mode → ${cfg.aiModel}`));
  const ctx = mkCtx(flags, cfg);
  const sys = systemPrompt(ctx);
  const messages = [{ role: "system", content: sys }];
  banner();
  const task = pos.join(" ").trim();
  if (task) {
    const prompted = flags.verify
      ? task + "\n\n(Cite every file you mention as path/file.ext:LINE so the receipts can be mechanically verified.)"
      : task;
    messages.push({ role: "user", content: prompted });
    const how = await agentTurn(cfg, messages, ctx);
    if (!flags.chat) {
      if (flags.verify && how === "done") await verifyReceipts(messages, ctx.cwd);
      return;
    }
  }
  console.log(dim("interactive mode — /yolo toggles auto-approve, /clear resets, /exit quits\n"));
  for (;;) {
    let line;
    try {
      line = await askUser(cyan("you › "));
    } catch {
      break;
    }
    if (line == null) break;
    const t2 = line.trim();
    if (/^\/(exit|quit)$/i.test(t2)) break;
    if (!t2) continue;
    if (/^\/yolo$/i.test(t2)) {
      ctx.yolo = !ctx.yolo;
      ok(`yolo ${ctx.yolo ? "ON — no more confirmations" : "OFF — confirming mutations"}`);
      continue;
    }
    if (/^\/clear$/i.test(t2)) {
      messages.length = 0;
      messages.push({ role: "system", content: sys });
      ok("context cleared");
      continue;
    }
    messages.push({ role: "user", content: t2 });
    trimHistory(messages);
    await agentTurn(cfg, messages, ctx);
  }
  console.log(dim("\nbye ⚡"));
}

/* ---------------- ask --verify: mechanically check every file:line receipt ---------------- */

async function verifyReceipts(messages, cwd) {
  const texts = messages.filter((m) => m.role === "assistant" && m.content).map((m) => String(m.content));
  const RE = /(^|[^\w./\-])([A-Za-z0-9_\-./\\]+\.[A-Za-z]{1,5})(?::(\d+)|#L(\d+))?/g;
  const seen = new Map();
  for (const txt of texts) {
    for (const m of txt.matchAll(RE)) {
      const file = m[2].replace(/\\/g, "/");
      const known =
        file.includes("/") ||
        /\.(js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|php|css|scss|html|json|md|yml|yaml|toml|sh|txt|sql|swift|kt|c|cpp|h|vue|svelte)$/.test(file);
      if (!known) continue;
      const line = Number(m[3] || m[4] || 0) || 0;
      const key = file + ":" + line;
      if (!seen.has(key)) seen.set(key, { file, line });
    }
  }
  const refs = [...seen.values()].slice(0, 40);
  if (!refs.length) return;
  let good = 0;
  const broken = [];
  for (const r of refs) {
    const abs = path.resolve(cwd, r.file);
    let valid = false;
    let why = "";
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        if (!r.line || r.line <= fs.readFileSync(abs, "utf8").split("\n").length) valid = true;
        else why = "line beyond end of file";
      } else why = "file not found";
    } catch {
      why = "unreadable";
    }
    if (valid) good++;
    else broken.push(`  ${red("✗")} ${r.file}${r.line ? ":" + r.line : ""} — ${why}`);
  }
  console.log("");
  if (!broken.length) ok(`receipts: ${refs.length} cited — all verified ✔`);
  else {
    warn(`receipts: ${refs.length} cited — ${good} verified, ${broken.length} broken:`);
    for (const b of broken) console.log(b);
  }
}

/* ---------------- git plumbing ---------------- */

function gitOut(args, cwd, ...redactSecrets) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0) {
    throw new UserErr(`git ${args.join(" ")} failed:\n${redact((r.stderr || r.stdout || "(no output)").trim(), ...redactSecrets)}`);
  }
  return (r.stdout || "").trim();
}

function gitRoot(dir) {
  try {
    return gitOut(["rev-parse", "--show-toplevel"], dir);
  } catch {
    return null;
  }
}

async function aiCommitMessage(cfg, root) {
  const stat = gitOut(["diff", "--cached", "--stat"], root);
  let recent = "";
  try {
    recent = gitOut(["log", "--oneline", "-5"], root);
  } catch {}
  try {
    const { message: ai } = await aiChat(cfg, [
      {
        role: "system",
        content:
          "You write git commit messages. Reply with ONE line only: conventional-commit style (feat|fix|chore|docs|refactor|test|style: summary). No quotes, no backticks, max 72 characters.",
      },
      { role: "user", content: `Staged changes:\n${capOut(stat, 1500)}\n\nRecent commits:\n${recent || "(none)"}` },
    ]);
    return String(ai.content || "")
      .split("\n")[0]
      .replace(/[`"']/g, "")
      .trim()
      .slice(0, 72);
  } catch (e) {
    warn(`AI commit message failed (${e.message}) — using fallback`);
    return "";
  }
}

async function cmdShip(pos, flags) {
  const cfg = loadConfig();
  const root = gitRoot(process.cwd());
  if (!root) throw new UserErr("Not inside a git repository (cd into your project first).");
  banner();
  gitOut(["add", "-A"], root);
  const st = gitOut(["status", "--porcelain"], root);
  if (!st) return ok("nothing to commit — working tree clean");
  const files = st.split("\n").length;
  console.log(dim(`staged ${files} file(s)`));
  let msg = pos.join(" ").trim();
  if (!msg) {
    console.log(dim("generating commit message with AI…"));
    msg = (await aiCommitMessage(cfg, root)) || `chore: update ${new Date().toISOString().slice(0, 10)}`;
  }
  console.log(`commit: ${bold(msg)}`);
  gitOut(["commit", "-m", msg], root);
  const branch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"], root);
  if (flags["no-push"]) {
    ok(`committed to ${cyan(branch)} — not pushing (--no-push)`);
    console.log("");
    return;
  }
  try {
    gitOut(["push", "-u", "origin", branch], root);
    ok(`pushed ${cyan(branch)} → origin`);
  } catch (e) {
    fail(e.message);
    info(dim("commit saved locally — push manually once your git credentials work, or check your token."));
  }
  console.log("");
}

function scaffoldNodeLib(name) {
  const safe = String(name || "my-lib").toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return {
    "package.json": JSON.stringify(
      {
        name: safe,
        version: "0.1.0",
        description: "",
        main: "index.js",
        scripts: { test: "node test/run.js" },
        keywords: [],
        license: "MIT",
      },
      null,
      2
    ) + "\n",
    "index.js": '"use strict";\n\nfunction hello(who = "world") {\n  return `hello ${who}`;\n}\n\nmodule.exports = { hello };\n',
    "test/run.js": '"use strict";\nconst assert = require("assert");\nconst { hello } = require("..");\n\nassert.strictEqual(hello(), "hello world");\nassert.strictEqual(hello("gitmancer"), "hello gitmancer");\nconsole.log("test/run.js — all assertions passed");\n',
    ".gitignore": "node_modules/\n*.log\n.DS_Store\n",
  };
}

async function cmdNewRepo(pos, flags) {
  const cfg = loadConfig();
  const name = pos[0];
  if (!name) throw new UserErr('usage: gitmancer newrepo <name> [--private] [--source <dir>] [--desc "..."] [--m "commit message"] [--template node-lib]');
  banner();
  const priv = !!flags.private;
  const tpl = flags.template === "node-lib" ? "node-lib" : null;
  console.log(dim(`creating ${priv ? "private" : "public"} repo ${name}${tpl ? ` from ${tpl} template` : ""} via GitHub API…`));
  const repo = await gh(cfg, "POST", "/user/repos", {
    name,
    private: priv,
    description: flags.desc || "",
    auto_init: false,
  });
  const login = repo.owner.login;
  ok(`created ${bold(`${login}/${name}`)} → ${repo.html_url}`);
  const src = flags.source ? path.resolve(flags.source) : null;
  if (src) {
    if (!fs.existsSync(src)) throw new UserErr(`source dir not found: ${src}`);
    if (tpl) {
      const files = scaffoldNodeLib(name);
      let made = 0;
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(src, rel);
        if (!fs.existsSync(abs)) {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content);
          made += 1;
        }
      }
      ok(`scaffolded ${tpl} template (${made} file(s)) into ${src}`);
    }
    console.log(dim(`pushing ${src} …`));
    if (!fs.existsSync(path.join(src, ".git"))) gitOut(["init", "-b", "main"], src);
    gitOut(["add", "-A"], src);
    if (gitOut(["status", "--porcelain"], src)) {
      gitOut(["commit", "-m", flags.m || "Initial commit via gitmancer ⚡"], src);
    }
    try {
      gitOut(["remote", "remove", "origin"], src);
    } catch {}
    gitOut(["remote", "add", "origin", `https://github.com/${login}/${name}.git`], src);
    let branch = "main";
    try {
      branch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"], src) || "main";
    } catch {}
    const pushUrl = `https://x-access-token:${cfg.githubToken}@github.com/${login}/${name}.git`;
    const r = spawnSync("git", ["push", pushUrl, branch], {
      cwd: src,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const out = redact((r.stdout || "") + (r.stderr || ""), cfg.githubToken);
    if (r.status !== 0) {
      fail(`push failed:\n${out.trim()}`);
      info(dim(`repo is created — push manually: cd ${src} && git push -u origin ${branch}`));
    } else {
      ok(`pushed ${cyan(branch)} → ${bold(`${login}/${name}`)}`);
      console.log(dim(out.trim()));
    }
  }
  console.log("");
}

async function cmdIssue(pos, flags) {
  const cfg = loadConfig();
  const repo = pos[0];
  const action = (pos[1] || "list").toLowerCase();
  if (!repo || !repo.includes("/")) throw new UserErr('usage: gitmancer issue <owner/repo> list | create "Title" [--body "..."] | close <number> | reopen <number>');
  banner();
  if (action === "list") {
    const items = await gh(cfg, "GET", `/repos/${repo}/issues?state=${flags.state || "open"}&per_page=${flags.limit || 20}`);
    const issues = (items || []).filter((i) => !i.pull_request);
    if (flags.json) {
      return console.log(
        JSON.stringify(
          issues.map((i) => ({ number: i.number, title: i.title, user: i.user && i.user.login, labels: (i.labels || []).map((l) => l.name), url: i.html_url })),
          null,
          2
        )
      );
    }
    if (!issues.length) return ok(`no ${flags.state || "open"} issues on ${repo}`);
    for (const i of issues) {
      const labels = (i.labels || []).map((l) => l.name).join(",");
      console.log(`  ${cyan("#" + i.number)} ${bold(i.title)} ${dim(i.user && i.user.login || "")} ${labels ? magenta("[" + labels + "]") : ""}`);
    }
    console.log("");
  } else if (action === "create") {
    const title = pos.slice(2).join(" ") || flags.title;
    if (!title) throw new UserErr('give a title: gitmancer issue owner/repo create "Something is broken"');
    const it = await gh(cfg, "POST", `/repos/${repo}/issues`, { title, body: flags.body || "" });
    ok(`created ${cyan("#" + it.number)} ${it.title} → ${it.html_url}`);
  } else if (action === "close") {
    const n = parseInt(pos[2], 10);
    if (!n) throw new UserErr("usage: gitmancer issue owner/repo close 12");
    await gh(cfg, "PATCH", `/repos/${repo}/issues/${n}`, { state: "closed" });
    ok(`closed #${n}`);
  } else if (action === "reopen") {
    const n = parseInt(pos[2], 10);
    if (!n) throw new UserErr("usage: gitmancer issue owner/repo reopen 12");
    await gh(cfg, "PATCH", `/repos/${repo}/issues/${n}`, { state: "open" });
    ok(`reopened #${n}`);
  } else {
    throw new UserErr(`unknown action "${action}" — try list | create | close | reopen`);
  }
}

/* ---------------- fix: auto-repair a failing command ---------------- */

async function cmdFix(pos, flags) {
  const command = pos.join(" ").trim();
  if (!command) throw new UserErr('usage: gitmancer fix "<command>"  — e.g. gitmancer fix "npm test"');
  const cfg = applyFast(loadConfig(), flags);
  if (cfg.__fast) console.log(dim(`fast mode → ${cfg.aiModel}`));
  const ctx = mkCtx(flags, cfg);
  banner();
  console.log(dim(`$ ${command}\n`));
  let r = runShell(command, ctx.cwd);
  console.log(capOut(r.out || "(no output)", 2000) + "\n");
  if (r.code === 0) return ok("exit 0 — command already passes, nothing to fix");
  warn(`exit ${r.code} — agent takes over, diagnosing…\n`);
  const messages = [
    { role: "system", content: systemPrompt(ctx) },
    {
      role: "user",
      content: `The command \`${command}\` just failed with exit code ${r.code}.\n\nCombined output (stdout+stderr):\n${r.out}\n\nDiagnose the root cause, make the minimal correct fix with your tools, then re-run \`${command}\` via run_cmd to verify it exits 0. Do not touch unrelated code.`,
    },
  ];
  const status = await agentTurn(cfg, messages, ctx);
  console.log(dim("\n── verify ──"));
  r = runShell(command, ctx.cwd);
  console.log(dim(capOut(r.out || "(no output)", 1500)));
  if (r.code === 0) ok("FIXED — command now exits 0 ⚡");
  else fail(`still exit ${r.code}${status === "done" ? " — inspect the output above or run fix again" : ""}`);
  console.log("");
}

/* ---------------- watch: auto-fix loop until a command goes green ---------------- */

async function cmdWatch(pos, flags) {
  const command = pos.join(" ").trim();
  if (!command) throw new UserErr('usage: gitmancer watch "<command>"  — e.g. gitmancer watch "npm test"');
  const maxTries = Math.min(Math.max(parseInt(flags.max, 10) || 3, 1), 10);
  const cfg = applyFast(loadConfig(), flags);
  const ctx = mkCtx(flags, cfg);
  banner();
  console.log(dim(`watching: $ ${command}  (up to ${maxTries} attempt${maxTries === 1 ? "" : "s"}, auto-fix between runs)\n`));
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const r = runShell(command, ctx.cwd);
    if (r.code === 0) {
      if (attempt === 1) ok("exit 0 — green on the first run ✅");
      else ok(`exit 0 — GREEN after ${attempt - 1} fix round${attempt - 1 === 1 ? "" : "s"} ⚡`);
      console.log("");
      return;
    }
    console.log(dim(capOut(r.out || "(no output)", 1500) + "\n"));
    if (attempt === maxTries) break;
    warn(`exit ${r.code} (attempt ${attempt}/${maxTries}) — agent auto-fixes, then re-runs…\n`);
    const messages = [
      { role: "system", content: systemPrompt(ctx) },
      {
        role: "user",
        content: `While running \`${command}\` (watch mode, attempt ${attempt}), the command failed with exit code ${r.code}.\n\nCombined output:\n${r.out}\n\nDiagnose the root cause, make the minimal correct fix with your tools, then re-run \`${command}\` via run_cmd to verify it exits 0. Do not touch unrelated code.`,
      },
    ];
    await agentTurn(cfg, messages, ctx);
    console.log(dim("\n── re-running watched command ──"));
  }
  fail(`watch: still failing after ${maxTries} attempt${maxTries === 1 ? "" : "s"} — inspect the output above`);
  console.log("");
}

/* ---------------- memory: GITMANCER.md project rules ---------------- */

function cmdMemory(pos, flags) {
  const file = path.join(process.cwd(), "GITMANCER.md");
  banner();
  if (fs.existsSync(file)) {
    const txt = fs.readFileSync(file, "utf8");
    ok(`GITMANCER.md found (${txt.length} chars) — auto-loaded into the AI's context on every run in this repo`);
    const lines = txt.split("\n");
    console.log(dim(lines.slice(0, 15).map((l) => "  │ " + l).join("\n")) + (lines.length > 15 ? dim("\n  │ …") : ""));
    console.log(dim("\nEdit it anytime to teach the agent your project's rules."));
    console.log("");
    return;
  }
  const template = [
    "# GITMANCER.md — project memory",
    "",
    "Everything in this file is loaded into gitmancer's AI context on every run",
    "in this repo. Keep it short and factual — it spends context tokens.",
    "",
    "## Build & test",
    "- Install: `npm install`",
    "- Test: `npm test`",
    "",
    "## Conventions",
    "- (example: use TypeScript strict mode; prefer named exports)",
    "",
    "## Do not touch",
    "- (example: never edit generated/; don't bump lockfile versions)",
    "",
  ].join("\n");
  fs.writeFileSync(file, template);
  ok("Created GITMANCER.md — teach the agent your project's rules");
  console.log(dim("Loaded automatically on every ask/agent/fix/ship/watch run in this repo.\nFill in the Build & test / Conventions / Do not touch sections."));
  console.log("");
}

/* ---------------- undo: revert the last agent file changes ---------------- */

function cmdUndo(pos, flags) {
  const f = path.join(CONFIG_DIR, "undo-journal.jsonl");
  let lines = [];
  try {
    lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  } catch {}
  banner();
  if (!lines.length) {
    ok("journal empty — nothing to undo");
    console.log("");
    return;
  }
  const n = Math.min(Math.max(parseInt(pos[0], 10) || 1, 1), 25);
  const take = lines.slice(-n).reverse();
  let done = 0;
  for (const line of take) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== "file" || !rec.file) continue;
    try {
      if (rec.prev == null) {
        if (fs.existsSync(rec.file)) {
          fs.unlinkSync(rec.file);
          console.log(`  ↩ removed ${rec.file}`);
        }
      } else {
        fs.writeFileSync(rec.file, rec.prev);
        console.log(`  ↩ restored ${rec.file}`);
      }
      done++;
    } catch (e) {
      console.log(`  ✗ ${rec.file}: ${e.message}`);
    }
  }
  lines = lines.slice(0, Math.max(lines.length - n, 0));
  try {
    fs.writeFileSync(f, lines.length ? lines.join("\n") + "\n" : "");
  } catch {}
  if (done) ok(`undone ${done} file change${done === 1 ? "" : "s"} — journal trimmed`);
  else warn("nothing restorable in those journal entries (run_cmd actions can't be undone)");
  console.log("");
}

/* ---------------- prbot: auto-review incoming pull requests ---------------- */

async function cmdPrbot(pos, flags) {
  const cfg = applyFast(loadConfig(), flags);
  const root = gitRoot(process.cwd());
  const repo = (typeof flags.repo === "string" && flags.repo) || (root ? parseOriginRepo(root) : null);
  if (!repo || !repo.includes("/")) throw new UserErr("usage: gitmancer prbot [--repo owner/name] [--interval 300] [--once] [--yolo]");
  const journal = path.join(CONFIG_DIR, "prbot.json");
  let seen = {};
  try {
    seen = JSON.parse(fs.readFileSync(journal, "utf8"));
  } catch {}
  seen[repo] = seen[repo] || {};
  const once = !!flags.once;
  const intervalS = Math.min(Math.max(parseInt(flags.interval, 10) || 300, 30), 3600);
  banner();
  console.log(dim(`prbot watching ${repo} — AI-reviews every new pull request${once ? " (single pass)" : ", sweep every " + intervalS + "s"}\n`));
  do {
    let prs = [];
    let fresh = 0;
    try {
      prs = await ghPaginate(cfg, `/repos/${repo}/pulls?state=open`, 50);
    } catch (e) {
      fail(`prbot: cannot list PRs — ${e.message}`);
      continue;
    }
    for (const p of prs) {
      const key = String(p.number);
      const sig = String((p.head && p.head.sha) || (p.head && p.head.ref) || key).slice(0, 12);
      if (seen[repo][key] === sig) continue; // already reviewed this head
      fresh++;
      console.log(cyan(`\n🔎 reviewing #${key}`) + dim(` ${p.title} (${sig})`));
      try {
        const diffUrl = p.diff_url || `${cfg.ghBase}/repos/${repo}/pulls/${p.number}`;
        const diff = await gh(cfg, "GET", diffUrl, undefined, { cache: false });
        const diffText = typeof diff === "string" ? diff : JSON.stringify(diff, null, 2);
        const { message } = await aiChat(cfg, [
          {
            role: "system",
            content:
              "You are a rigorous code reviewer. Review the PR diff. Output markdown:\n" +
              "1. **Verdict** — APPROVE / REQUEST CHANGES / COMMENT (one line)\n" +
              "2. **Findings** — bulleted, each prefixed [blocking], [major], [minor] or [nit], with file:line where possible.\n" +
              "Be concrete. No praise padding. Max ~200 words.",
          },
          { role: "user", content: `PR #${p.number}: ${p.title}\nBranch: ${p.head && p.head.ref} → ${p.base && p.base.ref}\n\nDiff:\n${capOut(diffText, 30000)}` },
        ]);
        const body = message && message.content ? String(message.content).trim() : "(no review generated)";
        const ctx = { cwd: root || process.cwd(), yolo: !!flags.yolo, always: { value: false }, cfg };
        if (await allow(`post review comment on PR #${p.number}`, ctx)) {
          await gh(cfg, "POST", `/repos/${repo}/issues/${p.number}/comments`, { body });
          ok(`review posted on #${p.number}`);
        } else {
          warn(`skipped posting #${p.number} — review kept local:\n${capOut(body, 800)}`);
        }
        seen[repo][key] = sig;
        try {
          fs.mkdirSync(CONFIG_DIR, { recursive: true });
          fs.writeFileSync(journal, JSON.stringify(seen, null, 2));
        } catch {}
      } catch (e) {
        fail(`#${p.number}: ${e.message}`);
      }
    }
    if (!prs.length) console.log(dim("no open pull requests"));
    else if (!fresh) console.log(dim("no new pull requests — all already reviewed"));
    if (!once) {
      console.log(dim(`\nnext sweep in ${intervalS}s — ctrl-c to stop`));
      await new Promise((r) => setTimeout(r, intervalS * 1000));
    }
  } while (!once);
  console.log("");
}

/* ---------------- pr: open a pull request (AI-drafted) ---------------- */

function parseOriginRepo(cwd) {
  try {
    const url = gitOut(["remote", "get-url", "origin"], cwd).replace(/\.git\/?$/, "");
    const m = url.match(/[/:]([^/]+)\/([^/]+)$/);
    if (m) return m[1] + "/" + m[2];
  } catch {}
  return null;
}

async function aiPrDraft(cfg, root, base) {
  let log = "";
  let stat = "";
  try {
    log = gitOut(["log", `origin/${base}..HEAD`, "--oneline"], root);
  } catch {
    try {
      log = gitOut(["log", "--oneline", "-8"], root);
    } catch {}
  }
  try {
    stat = gitOut(["diff", "--stat", `origin/${base}...HEAD`], root);
  } catch {}
  try {
    const { message } = await aiChat(cfg, [
      {
        role: "system",
        content:
          "You draft GitHub pull requests. First line: PR title (conventional-commit style, max 60 chars, no quotes/backticks). Then one blank line, then a SHORT markdown body (2-5 bullets: what changed & why). Nothing else.",
      },
      { role: "user", content: `Commits:\n${log || "(none)"}\n\nDiff stat:\n${capOut(stat, 1200) || "(none)"}` },
    ]);
    const text = String(message.content || "").trim();
    const nl = text.indexOf("\n");
    const title = (nl === -1 ? text : text.slice(0, nl)).replace(/[`"']/g, "").trim().slice(0, 60);
    const body = nl === -1 ? "" : text.slice(nl + 1).trim();
    return { title: title || `Merge ${base} updates`, body };
  } catch (e) {
    warn(`AI PR draft failed (${e.message}) — using fallback title`);
    return null;
  }
}

async function cmdPr(pos, flags) {
  const cfg = applyFast(loadConfig(), flags);
  const root = gitRoot(process.cwd());
  const repoArg = pos[0];
  const action = repoArg === "list" || repoArg === "close" || repoArg === "merge" ? repoArg : null;
  if (action) return cmdPrAction(action, pos.slice(1), flags, cfg);
  if (!root && !flags.repo) throw new UserErr("Not inside a git repo — pass --repo owner/name (and --head), or cd into your project.");
  const base = typeof flags.base === "string" ? flags.base : "main";
  const repo = (typeof flags.repo === "string" && flags.repo) || parseOriginRepo(root);
  if (!repo || !repo.includes("/")) throw new UserErr("cannot determine the repo — pass --repo owner/name");
  const head = (typeof flags.head === "string" && flags.head) || (root ? gitOut(["rev-parse", "--abbrev-ref", "HEAD"], root) : null);
  if (!head) throw new UserErr("cannot determine current branch — pass --head <branch>");
  if (head === base) throw new UserErr(`head (${head}) equals base (${base}) — commit your work on a feature branch first`);
  banner();
  let draft;
  const titleFlag = typeof flags.title === "string" ? flags.title : null;
  if (titleFlag) {
    draft = { title: titleFlag, body: typeof flags.body === "string" ? flags.body : "" };
  } else {
    console.log(dim("drafting PR title & body with AI…"));
    draft = (await aiPrDraft(cfg, root, base)) || { title: `Merge ${head} into ${base}`, body: "" };
  }
  console.log(
    `\n  ${bold("repo :")} ${repo}\n  ${bold("head :")} ${head} → ${bold("base:")} ${base}\n  ${bold("title:")} ${draft.title}${
      draft.body ? `\n  ${bold("body :")}\n${draft.body.split("\n").map((l) => "  " + l).join("\n")}` : ""
    }\n`
  );
  const ctx = { cwd: root || process.cwd(), yolo: !!flags.yolo, always: { value: false }, cfg };
  if (!(await allow(`open PR ${head} → ${base} on ${repo}`, ctx))) return warn("aborted — no PR created");
  const pr = await gh(cfg, "POST", `/repos/${repo}/pulls`, { title: draft.title, head, base, body: draft.body || "" });
  ok(`PR #${pr.number} opened → ${pr.html_url}`);
  console.log("");
}

/* ---------------- pr list / close / merge ---------------- */

function cmdPrAction(action, pos, flags, cfg) {
  if (action === "list") return cmdPrList(pos, flags, cfg);
  if (action === "close") return cmdPrClose(pos, flags, cfg);
  return cmdPrMerge(pos, flags, cfg);
}

async function prRepo(pos, flags, cfg) {
  const root = gitRoot(process.cwd());
  const posRepo = pos[0] && pos[0].includes("/") ? pos[0] : null;
  const repo = (typeof flags.repo === "string" && flags.repo) || posRepo || (root ? parseOriginRepo(root) : null);
  if (!repo || !repo.includes("/")) throw new UserErr("cannot determine the repo — pass --repo owner/name or run inside the repo");
  return repo;
}

async function cmdPrList(pos, flags, cfg) {
  const repo = await prRepo(pos, flags, cfg);
  const state = flags.state || "open";
  const items = await gh(cfg, "GET", `/repos/${repo}/pulls?state=${state}&per_page=${flags.limit || 20}`);
  const prs = items || [];
  if (flags.json) return console.log(JSON.stringify(prs.map((p) => ({ number: p.number, title: p.title, user: p.user && p.user.login, branch: p.head && p.head.ref, draft: !!p.draft, url: p.html_url })), null, 2));
  if (!prs.length) return ok(`no ${state} pull requests on ${repo}`);
  console.log(`\n${bold("Pull requests")} ${dim(state + " · " + repo)}\n`);
  for (const p of prs) {
    const branch = p.head && p.head.ref ? dim(p.head.ref) : "";
    const draft = p.draft ? yellow("[draft]") : "";
    console.log(`  ${cyan("#" + p.number)} ${bold(p.title)} ${draft} ${branch} ${dim(p.user && p.user.login || "")}`);
  }
  console.log("");
}

async function cmdPrClose(pos, flags, cfg) {
  const repo = await prRepo(pos, flags, cfg);
  const num = parseInt(pos[0], 10);
  if (!num) throw new UserErr("usage: gitmancer pr close <number> [--repo owner/name]");
  const ctx = { cwd: process.cwd(), yolo: !!flags.yolo, always: { value: false }, cfg };
  if (!(await allow(`close PR #${num} on ${repo}`, ctx))) return warn("aborted — PR left open");
  const p = await gh(cfg, "PATCH", `/repos/${repo}/pulls/${num}`, { state: "closed" });
  ok(`closed PR #${p.number} → ${p.html_url}`);
  console.log("");
}

async function cmdPrMerge(pos, flags, cfg) {
  const repo = await prRepo(pos, flags, cfg);
  const num = parseInt(pos[0], 10);
  if (!num) throw new UserErr("usage: gitmancer pr merge <number> [--merge|--squash|--rebase] [--repo owner/name]");
  const method = flags.squash ? "squash" : flags.rebase ? "rebase" : "merge";
  const body = { merge_method: method };
  if (typeof flags.subject === "string") body.commit_title = flags.subject;
  const ctx = { cwd: process.cwd(), yolo: !!flags.yolo, always: { value: false }, cfg };
  if (!(await allow(`merge PR #${num} on ${repo} (${method})`, ctx))) return warn("aborted — PR left open");
  const r = await gh(cfg, "PUT", `/repos/${repo}/pulls/${num}/merge`, body);
  if (r && r.merged) ok(`merged #${num} as ${cyan(r.sha.slice(0, 7))} (${r.merge_method || method})`);
  else warn(`not merged: ${r && r.message ? r.message : "unexpected response"}`);
  console.log("");
}

/* ---------------- changelog + release: AI release notes ---------------- */

function lastTag(root) {
  try {
    return gitOut(["describe", "--tags", "--abbrev=0"], root);
  } catch {
    return null;
  }
}

function rangeCommits(root, from, to) {
  const raw = gitOut(["log", "--pretty=format:%h%x09%s%x09%an%x09%ad", "--date=short", `${from}..${to}`], root);
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash, subject, author, date] = l.split("\t");
      return { hash, subject, author, date };
    });
}

async function aiReleaseNotes(cfg, commits, version) {
  const list = commits.map((c) => `- ${c.hash} ${c.subject} (${c.author})`).join("\n");
  const { message } = await aiChat(cfg, [
    {
      role: "system",
      content:
        "You write release notes in Keep-a-Changelog style markdown. Given a list of git commits, output concise markdown with sections Added / Changed / Fixed / Removed (omit empty ones), one bullet per meaningful change, mentioning short hashes. No preamble, no code fences.",
    },
    { role: "user", content: (version ? `Release version: ${version}\n\n` : "") + `Commits:\n${capOut(list, 6000)}` },
  ]);
  const md = String((message && message.content) || "")
    .replace(/```[a-z]*\n?/g, "")
    .trim();
  if (!md) throw new UserErr("AI returned empty release notes — check your AI key/model");
  return md;
}

function changelogHeading(title) {
  return `## ${title} — ${new Date().toISOString().slice(0, 10)}`;
}

function prependChangelog(root, heading, notes) {
  const p = path.join(root, "CHANGELOG.md");
  let old = "";
  try {
    old = fs.readFileSync(p, "utf8");
  } catch {}
  const next = old.trim()
    ? old.replace(/^(#[^\n]*\n)/, `$1\n${heading}\n\n${notes}\n`)
    : `# Changelog\n\n${heading}\n\n${notes}\n`;
  fs.writeFileSync(p, next);
  return p;
}

async function cmdChangelog(pos, flags) {
  const cfg = loadConfig();
  const ctx = mkCtx(flags, cfg);
  const root = gitRoot(process.cwd());
  if (!root) throw new UserErr("not inside a git repository");
  const to = typeof flags.to === "string" ? flags.to : "HEAD";
  const from = pos[0] || lastTag(root) || gitOut(["rev-list", "--max-parents=0", "HEAD"], root).split("\n")[0];
  const commits = rangeCommits(root, from, to);
  if (!commits.length) throw new UserErr(`no commits in range ${from}..${to}`);
  banner();
  console.log(dim(`range ${from}..${to} — ${commits.length} commits\n`));
  const notes = await aiReleaseNotes(cfg, commits, null);
  if (flags.json) return console.log(JSON.stringify({ range: `${from}..${to}`, commits: commits.length, markdown: notes }, null, 2));
  console.log(cyan(notes) + "\n");
  if (flags.write) {
    const heading = changelogHeading(to === "HEAD" ? "Unreleased" : to);
    if (await allow(`update CHANGELOG.md (${heading})`, ctx)) {
      prependChangelog(root, heading, notes);
      ok("CHANGELOG.md written");
    } else warn("skipped CHANGELOG.md write");
  }
}

async function cmdRelease(pos, flags) {
  const cfg = loadConfig();
  const ctx = mkCtx(flags, cfg);
  const root = gitRoot(process.cwd());
  if (!root) throw new UserErr("not inside a git repository");
  const bump = (pos[0] || "").toLowerCase();
  if (!["patch", "minor", "major"].includes(bump)) throw new UserErr("usage: gitmancer release patch|minor|major [--no-push] [--skip-gh] [--dry-run]");
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) throw new UserErr("release needs a package.json in the repo root");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    throw new UserErr("package.json is not valid JSON");
  }
  const cur = String(pkg.version || "0.0.0");
  const parts = cur.split(".").map((n) => parseInt(n, 10) || 0);
  if (bump === "patch") parts[2] += 1;
  else if (bump === "minor") {
    parts[1] += 1;
    parts[2] = 0;
  } else {
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
  }
  const next = parts.join(".");
  const tag = `v${next}`;

  const from = lastTag(root) || gitOut(["rev-list", "--max-parents=0", "HEAD"], root).split("\n")[0];
  const commits = rangeCommits(root, from, "HEAD");
  banner();
  console.log(dim(`release ${cur} → ${next} (${tag}) — ${commits.length} commits since ${from}\n`));
  const notes = await aiReleaseNotes(cfg, commits, tag);

  const plan = `bump ${cur} → ${next}, update CHANGELOG.md, commit + tag ${tag}${flags["no-push"] ? "" : " + push"}`;
  if (flags["dry-run"]) {
    console.log(cyan(notes) + "\n");
    warn(`dry-run — would ${plan}`);
    return;
  }
  if (!(await allow(plan, ctx))) return warn("release aborted");

  prependChangelog(root, changelogHeading(`[${next}]`), notes);
  const pkgText = fs.readFileSync(pkgPath, "utf8");
  if (!/"version"\s*:/.test(pkgText)) throw new UserErr("package.json has no version field");
  fs.writeFileSync(pkgPath, pkgText.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`));
  ok(`package.json ${cur} → ${next}, CHANGELOG.md updated`);

  gitOut(["add", "package.json", "CHANGELOG.md"], root);
  gitOut(["commit", "-m", `chore(release): ${tag}`], root);
  gitOut(["tag", tag], root);
  ok(`committed + tagged ${tag}`);

  if (flags["no-push"]) return warn("not pushing (--no-push)");
  gitOut(["push", "origin", "HEAD", "--follow-tags"], root);
  ok("pushed commit + tag");

  if (flags["skip-gh"]) return warn("skipping GitHub release (--skip-gh)");
  const slug = parseOriginRepo(root);
  if (!slug) return warn("no github origin — skipping GitHub release");
  if (!(await allow(`create GitHub release ${tag} on ${slug}`, ctx))) return warn("skipped GitHub release");
  try {
    await gh(cfg, "POST", `/repos/${slug}/releases`, { tag_name: tag, name: tag, body: notes, draft: false, prerelease: false });
    ok(`GitHub release ${tag} published`);
  } catch (e) {
    warn(`GitHub release failed: ${e.message} — tag is pushed, create it manually if needed`);
  }
}

/* ---------------- secscan: gitleaks-style secret scanning ---------------- */

const SECRET_RULES = [
  { id: "aws-key", label: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "github-token", label: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { id: "openai-key", label: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { id: "slack-token", label: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "google-key", label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "private-key", label: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "generic-secret", label: "hard-coded secret", re: /(?:api[_-]?key|apikey|secret|passwd|password|token|auth)\s*[:=]\s*["'][^"']{8,}["']/i },
];

const SECRET_PLACEHOLDER =
  /(?:xxxx|example|changeme|change-me|placeholder|your[-_]|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|\bnull\b|test[-_]?key\b|dummy|sample|redacted|sk-xxx)/i;

function scanTextForSecrets(text) {
  const findings = [];
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const rule of SECRET_RULES) {
      rule.re.lastIndex = 0;
      const m = rule.re.exec(lines[i]);
      if (!m) continue;
      const snippet = m[0].trim();
      if (SECRET_PLACEHOLDER.test(snippet)) continue;
      const preview = snippet.length > 10 ? snippet.slice(0, 6) + "…" + "****" + ` (${snippet.length} chars)` : snippet;
      findings.push({ rule: rule.id, label: rule.label, line: i + 1, preview });
      break; // one finding per line — first rule wins
    }
  }
  return findings;
}

function isBinaryBuf(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function scanRepoForSecrets(root, opts = {}) {
  const res = { findings: [], scanned: 0, skipped: 0, truncated: false };
  if (opts.staged) {
    let diff = "";
    try {
      diff = gitOut(["diff", "--cached", "--unified=0", "--no-color"], root);
    } catch (e) {
      throw new UserErr(e.message);
    }
    let curFile = "(unknown)";
    for (const line of diff.split("\n")) {
      if (line.startsWith("+++ b/")) curFile = line.slice(6);
      else if (line.startsWith("+") && !line.startsWith("+++")) {
        for (const f of scanTextForSecrets(line.slice(1))) res.findings.push({ file: curFile, ...f });
      }
    }
    return res;
  }
  let files = [];
  try {
    files = (typeof opts.path === "string" && opts.path) ? [opts.path] : gitOut(["ls-files"], root).split("\n").filter(Boolean);
  } catch (e) {
    throw new UserErr(`not a git repository? (${String(e.message).split("\n")[0]})`);
  }
  const MAX_FILES = 2000;
  const MAX_BYTES = 1024 * 1024;
  if (files.length > MAX_FILES) {
    res.truncated = true;
    files = files.slice(0, MAX_FILES);
  }
  for (const f of files) {
    const abs = path.resolve(root, f);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_BYTES) {
      res.skipped++;
      continue;
    }
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      res.skipped++;
      continue;
    }
    if (isBinaryBuf(buf)) {
      res.skipped++;
      continue;
    }
    for (const fnd of scanTextForSecrets(buf.toString("utf8"))) res.findings.push({ file: f, ...fnd });
    res.scanned++;
  }
  return res;
}

async function cmdSecscan(pos, flags) {
  const root = gitRoot(process.cwd());
  if (!root) throw new UserErr("secscan must run inside a git repository");
  const opts = { staged: !!flags.staged, path: typeof flags.path === "string" ? flags.path : null };
  const res = scanRepoForSecrets(root, opts);
  if (flags.json) return console.log(JSON.stringify({ scanned: res.scanned, skipped: res.skipped, truncated: res.truncated, count: res.findings.length, findings: res.findings }, null, 2));
  banner();
  const scope = opts.staged ? "staged changes" : opts.path ? `path ${opts.path}` : "tracked files";
  console.log(dim(`scanning ${scope}…\n`));
  for (const f of res.findings) {
    console.log(`  ${red("✖")} ${bold(f.file)}:${f.line}  ${yellow(f.rule)}  ${dim(f.label)}  ${f.preview}`);
  }
  if (!res.findings.length) {
    ok(`clean — no secrets in ${res.scanned} file(s)${res.skipped ? ` (skipped ${res.skipped} binary/large)` : ""}`);
  } else {
    fail(`${res.findings.length} potential secret(s) found — revoke & rotate, never commit them`);
    console.log(dim(`\ntip: gitmancer hook install pre-commit  → blocks commits containing secrets`));
  }
  if (res.truncated) warn(`file list truncated at 2000 files`);
  process.exitCode = res.findings.length ? 1 : 0;
}

/* ---------------- review: AI code review of a pull request ---------------- */

async function cmdReview(pos, flags) {
  const cfg = applyFast(loadConfig(), flags);
  const root = gitRoot(process.cwd());
  const repo = (typeof flags.repo === "string" && flags.repo) || (root ? parseOriginRepo(root) : null);
  const num = parseInt(pos[0], 10);
  if (!repo || !repo.includes("/")) throw new UserErr("usage: gitmancer review <pr-number> [--repo owner/name]  (run inside the repo or pass --repo)");
  if (!num) throw new UserErr("usage: gitmancer review <pr-number> — e.g. gitmancer review 12");
  banner();
  console.log(dim(`fetching PR #${num} on ${repo}…`));
  const pr = await gh(cfg, "GET", `/repos/${repo}/pulls/${num}`);
  const diffUrl = pr.diff_url || `${cfg.ghBase}/repos/${repo}/pulls/${num}`;
  const diff = await gh(cfg, "GET", diffUrl, undefined, { cache: false }); // raw text (Accept overrides via diff_url)
  const diffText = typeof diff === "string" ? diff : JSON.stringify(diff, null, 2);
  console.log(dim(`PR: ${pr.title} (+${pr.additions ?? "?"}/-${pr.deletions ?? "?"} · ${pr.changed_files ?? "?"} files) — reviewing…\n`));
  const { message } = await aiChat(cfg, [
    {
      role: "system",
      content:
        "You are a rigorous code reviewer. Review the PR diff. Output markdown:\n" +
        "1. **Verdict** — APPROVE / REQUEST CHANGES / COMMENT (one line)\n" +
        "2. **Findings** — bulleted, each prefixed [blocking], [major], [minor] or [nit], with file:line where possible\n" +
        "3. **Missing tests/risks** — 1-3 bullets max.\n" +
        "Be concrete. No praise padding. Max ~250 words.",
    },
    {
      role: "user",
      content: `PR #${num}: ${pr.title}\nBranch: ${pr.head && pr.head.ref} → ${pr.base && pr.base.ref}\n\nDiff:\n${capOut(diffText, 40000)}`,
    },
  ], null, { stream: true, onDelta: (t) => process.stdout.write(t) });
  if (!message || !message.content) throw new UserErr("review returned empty — check your AI key/model");
  console.log("\n");
}

/* ---------------- status: one-shot repo dashboard ---------------- */

async function cmdStatus(pos, flags) {
  const cfg = loadConfig();
  const root = gitRoot(process.cwd());
  const repo = (typeof flags.repo === "string" && flags.repo) || (root ? parseOriginRepo(root) : null);
  const out = { repo: repo || null, local: null, github: null };
  const rows = [];
  if (root) {
    const branch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"], root);
    const dirty = gitOut(["status", "--porcelain"], root).split("\n").filter(Boolean).length;
    let counts = "";
    try {
      counts = gitOut(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], root);
    } catch {}
    const [behind, ahead] = counts ? counts.split(/\s+/) : ["0", "0"];
    const last = gitOut(["log", "--oneline", "-1"], root);
    out.local = { branch, dirty, ahead: Number(ahead) || 0, behind: Number(behind) || 0, last };
    rows.push(`  ${bold("repo   ")} : ${bold(repo || dim("(no origin)"))}`);
    rows.push(`  ${bold("branch ")} : ${cyan(branch)}${dirty ? yellow(`  ${dirty} dirty file(s)`) : green("  clean")}`);
    rows.push(`  ${bold("sync   ")} : ${dim(`ahead ${ahead || 0}, behind ${behind || 0}`)}`);
    rows.push(`  ${bold("last   ")} : ${dim(last)}`);
  } else {
    rows.push(dim("  (not inside a git repo — showing GitHub-side info only)"));
  }
  if (repo && cfg.githubToken) {
    try {
      const [r, issues, prs, runs] = await Promise.all([
        gh(cfg, "GET", `/repos/${repo}`),
        gh(cfg, "GET", `/repos/${repo}/issues?state=open&per_page=100`),
        gh(cfg, "GET", `/repos/${repo}/pulls?state=open&per_page=100`),
        gh(cfg, "GET", `/repos/${repo}/actions/runs?per_page=1`).catch(() => null),
      ]);
      const openIssues = (issues || []).filter((i) => !i.pull_request).length;
      const openPrs = (prs || []).length;
      const run = runs && runs.workflow_runs && runs.workflow_runs[0];
      out.github = {
        defaultBranch: r.default_branch,
        stars: r.stargazers_count,
        openIssues,
        openPrs,
        lastRun: run ? { name: run.name, status: run.status, conclusion: run.conclusion } : null,
      };
      rows.push(`  ${bold("issues ")} : ${openIssues} open`);
      rows.push(`  ${bold("prs    ")} : ${openPrs} open`);
      if (run) {
        rows.push(`  ${bold("CI     ")} : ${run.conclusion === "success" ? green("✔ " + run.conclusion) : yellow(run.status + (run.conclusion ? "/" + run.conclusion : ""))} ${dim(run.head_branch + " · " + run.name)}`);
      }
    } catch (e) {
      rows.push(yellow(`  ${bold("github ")} : ${e.message}`));
    }
  }
  if (flags.json) return console.log(JSON.stringify(out, null, 2));
  banner();
  console.log("\n" + rows.join("\n") + "\n");
}

/* ---------------- sweep: batch overview across all your repos ---------------- */

async function cmdSweep(pos, flags) {
  const cfg = loadConfig();
  const bannerFirst = !flags.json;
  if (bannerFirst) {
    banner();
    console.log(dim("listing your repositories…"));
  }
  const limit = parseInt(flags.limit, 10) || 30;
  const repos = await ghPaginate(cfg, "/user/repos?sort=pushed", limit);
  const mine = (repos || []).slice(0, limit);
  if (!mine.length) return ok("no repositories found");
  const results = [];
  const QUEUE = [...mine];
  const workers = Array.from({ length: Math.min(5, QUEUE.length) }, async () => {
    for (;;) {
      const r = QUEUE.shift();
      if (!r) break;
      const row = { repo: r.full_name, language: r.language, stars: r.stargazers_count, pushed: (r.pushed_at || "").slice(0, 10), openIssues: null, openPrs: null };
      const counts = await Promise.all([
        gh(cfg, "GET", `/repos/${r.full_name}/issues?state=open&per_page=100`).then((a) => (a || []).filter((i) => !i.pull_request).length).catch(() => null),
        gh(cfg, "GET", `/repos/${r.full_name}/pulls?state=open&per_page=100`).then((a) => (a || []).length).catch(() => null),
      ]);
      row.openIssues = counts[0];
      row.openPrs = counts[1];
      results.push(row);
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => (b.pushed || "").localeCompare(a.pushed || ""));
  if (flags.json) return console.log(JSON.stringify(results, null, 2));
  console.log(`\n${bold(results.length + " repos (by last push):")}\n`);
  for (const r of results) {
    const lang = r.language ? dim(r.language) : dim("—");
    const stars = r.stars ? cyan(`★${r.stars}`) : "";
    const counts = dim(`i:${r.openIssues ?? "?"} pr:${r.openPrs ?? "?"}`);
    console.log(`  ${bold(r.repo)}  ${lang}  ${stars}  ${counts}  ${dim(r.pushed)}`);
  }
  console.log(dim("\nopen counts fetched 5-at-a-time · use --json for scripting\n"));
}

/* ---------------- doctor: config & connectivity diagnostics ---------------- */

async function cmdDoctor() {
  const cfg = loadConfig();
  banner();
  let critical = 0;
  const line = (pass, label, detail) => console.log(`  ${pass ? green("✔") : yellow("▲")} ${label.padEnd(18)} ${dim(detail)}`);
  const bad = (label, detail) => {
    console.log(`  ${red("✖")} ${label.padEnd(18)} ${dim(detail)}`);
    critical += 1;
  };
  console.log("");
  const maj = Number(process.versions.node.split(".")[0]);
  if (maj >= 18) line(true, "node", process.version + " (fetch available)");
  else bad("node", `${process.version} — Node 18+ required for built-in fetch`);
  const exists = fs.existsSync(CONFIG_FILE);
  if (exists) line(true, "config file", CONFIG_FILE);
  else line(false, "config file", CONFIG_FILE + " missing — run `gitmancer setup`");
  if (cfg.aiKey) line(true, "AI key", mask(cfg.aiKey));
  else bad("AI key", "not set — run `gitmancer setup` or export GITMANCER_AI_KEY");
  if (cfg.aiFallbacks && cfg.aiFallbacks.length) {
    const okShape = cfg.aiFallbacks.every((f) => f && f.base && f.model);
    if (okShape) line(true, "AI fallbacks", cfg.aiFallbacks.map((f) => f.model).join(" → "));
    else bad("AI fallbacks", "invalid shape — each needs { base, model, key? }");
  } else line(true, "AI fallbacks", "none configured (optional)");
  if (cfg.githubToken) line(true, "GitHub token", mask(cfg.githubToken));
  else bad("GitHub token", "not set — account features disabled until you run `gitmancer setup`");
  try {
    const u = await gh(cfg, "GET", "/user");
    line(true, "GitHub API", `${cfg.ghBase} — authenticated as ${u.login}`);
  } catch (e) {
    bad("GitHub API", String(e.message).slice(0, 120));
  }
  try {
    const isLocal = /localhost|127\.0\.0\.1/.test(cfg.aiBase);
    if (!cfg.aiKey && !isLocal) throw new UserErr("no key — skipping value only");
    const res = await fetch(cfg.aiBase.replace(/\/$/, "") + "/models", {
      headers: cfg.aiKey ? { Authorization: `Bearer ${cfg.aiKey}` } : {},
    });
    line(res.ok, "AI endpoint", `${cfg.aiBase} — HTTP ${res.status}${res.ok ? "" : " (some providers 401 /models; chat may still work)"}`);
  } catch (e) {
    bad("AI endpoint", `${cfg.aiBase} — ${String(e.message).slice(0, 100)}`);
  }
  console.log(dim(`\n  cache: ${_ghCache.size} entr${_ghCache.size === 1 ? "y" : "ies"} · MAX_STEPS=${MAX_STEPS} · version ${VERSION}\n`));
  if (critical) {
    fail(`${critical} critical issue(s) — fix the ✖ lines above`);
    process.exitCode = 1;
  } else ok("all critical checks passed ⚡");
  console.log("");
}

/* ---------------- help / arg parsing / main ---------------- */

function help() {
  banner();
  console.log(`${bold("USAGE")}
  gitmancer <command> [args] [flags]

${bold("COMMANDS")}
  ${cyan("setup")}                  store AI key + GitHub token locally (~/.gitmancer/config.json)
                    ${dim("--preset groq|openai|openrouter|zai|ollama|custom  --key  --token  --model  --base")}
  ${cyan("config")}                 show current config (secrets masked)
  ${cyan("whoami")}                 verify GitHub token — who are you on GitHub? ${dim("--json")}
  ${cyan("repos")}                  list your repositories           ${dim('--limit 50  --json')}
  ${cyan('ask')} "<task>"           AI agent: reads/writes code, runs commands, calls GitHub
                    ${dim('--yolo (skip confirmations)  --chat (stay in conversation)  --fast (small model)  --steps 50  --cwd <dir>  --budget 200000')}
  ${cyan('fix')} "<cmd>"            run a command; if it fails, the agent auto-fixes the code & re-verifies
                    ${dim('--yolo  --fast  --cwd <dir>')}
  ${cyan("ship")} ["message"]       stage all, AI commit message (if omitted), push current branch
                    ${dim('--no-push (commit locally only)')}
  ${cyan("newrepo")} <name>         create GitHub repo + optionally push a folder in one shot
                    ${dim("--private  --source <dir>  --desc \"…\"  --m \"initial commit msg\"  --template node-lib")}
  ${cyan("issue")} <owner/repo> …   list | create "Title" [--body "…"] | close <number> | reopen <number>
                    ${dim('--state all|open|closed  --limit N  --json')}
  ${cyan("pr")}                    open a pull request — AI drafts title & body from your commits
                    ${dim('--base main  --head <branch>  --repo owner/name  --title "…"  --body "…"  --yolo')}
  ${cyan("pr list")}                list pull requests                ${dim('--state all|open|closed|merged  --repo owner/name  --json')}
  ${cyan("pr close")} <n>           close a pull request              ${dim('--repo owner/name  --yolo')}
  ${cyan("pr merge")} <n>           merge a PR — confirm-gated        ${dim('--squash  --rebase  --subject "…"  --repo owner/name')}
  ${cyan("status")}                 dashboard: branch, dirty files, ahead/behind, open issues/PRs, last CI run
                    ${dim('--repo owner/name  --json')}
  ${cyan("review")} <pr#>           AI code review of a pull request — severity-tagged findings + verdict
                    ${dim('--repo owner/name  --fast')}
  ${cyan("sweep")}                 batch overview of ALL your repos — open issues/PRs per repo, 5-at-a-time
                    ${dim('--limit 30  --json')}
  ${cyan("doctor")}                 diagnose setup: keys, tokens, endpoints, fallbacks — tells you what to fix
  ${cyan("memory")}                 create/show GITMANCER.md — project rules auto-loaded into every AI run
  ${cyan("undo")} [n]               revert the last n agent file changes (journal-based, default 1)
  ${cyan("watch")} "<cmd>"          run a command; on failure the agent auto-fixes and re-runs until green
                    ${dim('--max 3  --yolo  --fast')}
  ${cyan("prbot")}                 watch a repo and AI-review every new pull request
                    ${dim('--repo owner/name  --interval 300  --once  --yolo')}
  ${cyan("changelog")} [from]      AI release notes for a commit range (default: since last tag)
                    ${dim('--to HEAD  --write (CHANGELOG.md)  --json')}
  ${cyan("release")} patch|minor|major
                    ${dim('bump version + CHANGELOG + tag + push + GitHub release  --no-push  --skip-gh  --dry-run')}
  ${cyan("secscan")}               scan tracked files (or --staged) for API keys & secrets — exit 1 if found
                    ${dim('--staged  --path <p>  --json')}
  ${cyan("help")} / ${cyan("version")}

${bold("PROVIDERS")}
  any OpenAI-compatible API works — set once in setup:
    groq (free) · openai · openrouter · zai · ollama (local) · custom base URL

${bold("SAFETY")}
  tokens live only in ~/.gitmancer/config.json (chmod 600) — never uploaded, never logged.
  writes / commands / GitHub mutations ask before acting, unless --yolo.

${bold("EXAMPLES")}
  gitmancer ask "what does this repo do? then fix the typo in README"
  gitmancer ask --yolo --steps 50 "add tests for utils.js and run them"
  gitmancer fix "npm test"                ${dim("# tests failing? the agent repairs code & re-verifies")}
  gitmancer pr --base main                ${dim("# AI-drafted PR from your current branch")}
  gitmancer pr list --state all --json    ${dim("# full PR inventory for scripts")}
  gitmancer pr merge 12 --squash          ${dim("# confirm-gated merge")}
  gitmancer review 12                     ${dim("# AI code review: findings + verdict")}
  gitmancer status                        ${dim("# branch, sync, issues/PRs, CI — one shot")}
  gitmancer sweep --json | jq '.[].repo'  ${dim("# all repos, scriptable")}
  gitmancer doctor                        ${dim("# is my setup broken? what exactly?")}
  gitmancer ship --no-push                ${dim("# AI commit message, stay local")}
  gitmancer newrepo my-lib --template node-lib --source ./my-lib
  gitmancer issue me/myrepo create "Bug: login fails on Safari"
  gitmancer secscan --staged             ${dim("# block secrets before they're committed")}
  gitmancer hook install pre-commit      ${dim("# enforce secscan on every commit")}
`);
}

const BOOLEAN_FLAGS = new Set(["yolo", "chat", "private", "public", "push", "help", "version", "force", "fast", "no-cache", "json", "no-push", "squash", "rebase", "no-color", "once", "verify", "write", "apply", "draft", "prerelease", "ai", "run", "staged"]);

function parseArgs(argv) {
  let cmd = null;
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (/^--/.test(a) || (/^-/.test(a) && a.length > 1 && !/^-[0-9]/.test(a))) {
      const key = a.replace(/^--?/, "");
      const eq = key.indexOf("=");
      if (eq !== -1) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || /^-/.test(next)) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
      continue;
    }
    if (cmd === null) cmd = a;
    else pos.push(a);
  }
  return { cmd, pos, flags };
}

async function main() {
  const argv = process.argv.slice(2);
  const { cmd, pos, flags } = parseArgs(argv);
  if (flags["no-color"] || process.env.NO_COLOR) FORCE_COLOR_OFF = true;
  if (flags.version || flags.v) return console.log(`${NAME} v${VERSION}`);
  if (flags.help || flags.h) return help();
  if (!cmd || cmd === "help") return help();
  switch (cmd) {
    case "help": return help();
    case "version": return console.log(`${NAME} v${VERSION}`);
    case "setup": return cmdSetup(flags);
    case "config": return cmdConfig();
    case "whoami": return cmdWhoami(flags);
    case "repos": return cmdRepos(flags);
    case "ask":
    case "agent": return cmdAsk(pos, flags);
    case "ship": return cmdShip(pos, flags);
    case "newrepo": return cmdNewRepo(pos, flags);
    case "issue": return cmdIssue(pos, flags);
    case "fix": return cmdFix(pos, flags);
    case "pr": return cmdPr(pos, flags);
    case "status": return cmdStatus(pos, flags);
    case "review": return cmdReview(pos, flags);
    case "sweep": return cmdSweep(pos, flags);
    case "doctor": return cmdDoctor();
    case "memory": return cmdMemory(pos, flags);
    case "undo": return cmdUndo(pos, flags);
    case "watch": return cmdWatch(pos, flags);
    case "prbot": return cmdPrbot(pos, flags);
    case "changelog": return cmdChangelog(pos, flags);
    case "release": return cmdRelease(pos, flags);
    case "secscan": return cmdSecscan(pos, flags);
    default:
      // shorthand: gitmancer "do a thing" → ask
      return cmdAsk([cmd, ...pos], flags);
  }
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((e) => {
    fail(e instanceof UserErr ? e.message : (e && e.stack) || String(e));
    process.exit(1);
  });
