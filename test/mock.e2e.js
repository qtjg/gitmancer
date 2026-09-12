const http = require("http");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

/* gitmancer end-to-end test — spins a local mock AI server + mock GitHub API,
 * then drives the real CLI against them. Zero dependencies.
 * NOTE: the mock server lives in THIS process, so the CLI must be spawned
 * ASYNC (spawn, not spawnSync) — spawnSync would freeze this event loop
 * and deadlock the HTTP handshake. */

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "gitmancer.js");

let aiCalls = 0;
let fixCalls = 0;
let paraCalls = 0;
let mixCalls = 0;
let undoCalls = 0;
let batchCalls = 0;
let userHits = 0;
let retryTrips = 0;
let cacheAsks = 0;
const failed = [];

function check(name, cond) {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    console.error(`  ✖ ${name}`);
    failed.push(name);
  }
}

function respond(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function sseRespond(res, message) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ choices: [{ delta: { role: "assistant", content: "" } }] });
  if (message.content) {
    const half = Math.ceil(message.content.length / 2);
    send({ choices: [{ delta: { content: message.content.slice(0, half) } }] });
    send({ choices: [{ delta: { content: message.content.slice(half) } }] });
  }
  (message.tool_calls || []).forEach((tc, i) => {
    send({ choices: [{ delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] } }] });
    send({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] } }] });
  });
  send({ choices: [{ delta: {}, finish_reason: message.tool_calls && message.tool_calls.length ? "tool_calls" : "stop" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url.includes("/chat/completions")) {
      aiCalls++;
      let reqBody = {};
      try {
        reqBody = JSON.parse(body || "{}");
      } catch {}
      const lastUser = ((reqBody.messages || []).filter((m) => m.role === "user").pop() || {}).content || "";
      let message;
      if (/retry test/.test(String(lastUser))) {
        // transient-failure flow: first request → 500, retried request → final text
        if (retryTrips++ === 0) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "transient server error" } }));
          return;
        }
        message = { role: "assistant", content: "retry ok — recovered after transient 500." };
      } else if (/cache test/.test(String(lastUser))) {
        // cache flow: 1st call → TWO identical GET /user tool calls, 2nd → final text
        cacheAsks++;
        message =
          cacheAsks % 2 === 1
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "gh1", type: "function", function: { name: "github_api", arguments: JSON.stringify({ method: "GET", endpoint: "/user" }) } },
                  { id: "gh2", type: "function", function: { name: "github_api", arguments: JSON.stringify({ method: "GET", endpoint: "/user" }) } },
                ],
              }
            : { role: "assistant", content: "Done — two identical GETs, second served from cache." };
      } else if (/^PR #/.test(String(lastUser))) {
        // review flow: plain streamed text verdict, no tool calls
        message = { role: "assistant", content: "Verdict: APPROVE — diff is minimal and correct." };
      } else if (/just failed with exit code/.test(String(lastUser))) {
        // fix flow: 1st call → write app.js, 2nd call → final text
        fixCalls++;
        message =
          fixCalls % 2 === 1
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `fix_${fixCalls}`,
                    type: "function",
                    function: { name: "write_file", arguments: JSON.stringify({ path: "app.js", content: "console.log('ok');\n" }) },
                  },
                ],
              }
            : { role: "assistant", content: "Wrote the missing app.js — syntax is valid now." };
      } else if (/^parallel test$/.test(String(lastUser))) {
        // parallel dispatch: one turn → 3 read-only tool calls, follow-up → final text
        paraCalls++;
        message =
          paraCalls % 2 === 1
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "pa1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } },
                  { id: "pa2", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "b.txt" }) } },
                  { id: "pa3", type: "function", function: { name: "list_files", arguments: JSON.stringify({ path: "." }) } },
                ],
              }
            : { role: "assistant", content: "Done — parallel reads complete." };
      } else if (/^mixed test$/.test(String(lastUser))) {
        // mixed batch: read-only + mutating in one turn — mutating must stay gated
        mixCalls++;
        message =
          mixCalls % 2 === 1
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "mx1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "ok.txt" }) } },
                  { id: "mx2", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "bad.txt", content: "evil" }) } },
                ],
              }
            : { role: "assistant", content: "Done — mixed handled." };
      } else if (/^memory test$/.test(String(lastUser))) {
        // memory flow: reply depends on whether GITMANCER.md reached the system prompt
        const sys = (reqBody.messages || [])[0] || {};
        message = { role: "assistant", content: String(sys.content || "").includes("RULE-MARKER-123") ? "MEMORY-OK loaded." : "MEMORY-MISS — project memory absent." };
      } else if (/^undo test$/.test(String(lastUser))) {
        // undo flow: 1st call → overwrite data.txt, 2nd → final text
        undoCalls++;
        message =
          undoCalls % 2 === 1
            ? { role: "assistant", content: null, tool_calls: [{ id: `undo_${undoCalls}`, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "data.txt", content: "OVERWRITTEN" }) } }] }
            : { role: "assistant", content: "Overwrote data.txt — undo stage one done." };
      } else if (/^batch test$/.test(String(lastUser))) {
        // batch_edit flow: 1st call → batch_edit tool call, 2nd → final text
        batchCalls++;
        message =
          batchCalls % 2 === 1
            ? { role: "assistant", content: null, tool_calls: [{ id: `batch_${batchCalls}`, type: "function", function: { name: "batch_edit", arguments: JSON.stringify({ path: "app.js", edits: [{ find: "var a = 1", replace: "var b = 1" }, { find: "var sum = a + 2", replace: "var sum = b + 2" }] }) } }] }
            : { role: "assistant", content: "batch done." };
      } else if (/Keep-a-Changelog/.test(String((((reqBody.messages || [])[0]) || {}).content || ""))) {
        // changelog/release release-notes flow → deterministic markdown
        message = { role: "assistant", content: "### Added\n- MOCK-NOTE feature one (abc1234)\n### Fixed\n- MOCK-NOTE crash on start (def5678)" };
      } else if (/\[gitmancer testgen\]/.test(String((((reqBody.messages || [])[0]) || {}).content || ""))) {
        // testgen flow: deterministic test-file content (wrapped in fences to exercise stripping)
        message = { role: "assistant", content: "```js\n// MOCK-TEST generated\nconst test = require('node:test');\n```" };
      } else if (/\[explain:/.test(String((((reqBody.messages || [])[0]) || {}).content || ""))) {
        // explain flow: echo the resolved mode back
        const sys0 = String((((reqBody.messages || [])[0]) || {}).content || "");
        const em = (/\[explain:(\w+)\]/.exec(sys0) || [])[1] || "?";
        message = { role: "assistant", content: `EXPLAIN-OK (${em}) — mock explanation.` };
      } else if (/receipts verify test/.test(String(lastUser))) {
        // ask --verify flow: cite one real file:line and one broken reference
        message = { role: "assistant", content: "The adder lives in `calc.js:1`; the old helper was `missing.js:9`." };
      } else if (/hello2/.test(String(lastUser))) {
        // budget flow: always demand a write so the budget check trips on the next step
        message = { role: "assistant", content: null, tool_calls: [{ id: "bud1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "hello2.txt", content: "budget" }) } }] };
      } else if (aiCalls % 2 === 1) {
        // odd call → request a file write (so both yolo and deny scenarios work)
        message = {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_${aiCalls}`,
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "hello.txt", content: "hello from gitmancer" }),
              },
            },
          ],
        };
      } else {
        message = { role: "assistant", content: "Done — handled hello.txt." };
      }
      if (reqBody.stream) sseRespond(res, message);
      else respond(res, { choices: [{ message }] });
    } else if (req.method === "PUT" && req.url.endsWith("/pulls/7/merge")) {
      respond(res, { merged: true, sha: "abc1234def567890", merge_method: "squash" });
    } else if (req.method === "PATCH" && req.url.endsWith("/pulls/7")) {
      respond(res, { number: 7, state: "closed", html_url: "https://github.com/acme/widget/pull/7" });
    } else if (req.method === "PATCH" && req.url.endsWith("/issues/5")) {
      respond(res, { number: 5, state: "open", html_url: "https://github.com/acme/widget/issues/5" });
    } else if (req.url.startsWith("/repos/acme/widget/pulls?")) {
      respond(res, [{ number: 7, title: "Add widget", user: { login: "mayank-test" }, head: { ref: "feature" }, draft: false, html_url: "https://github.com/acme/widget/pull/7" }]);
    } else if (req.method === "POST" && req.url.endsWith("/pulls")) {
      respond(res, { number: 7, title: "Add widget", html_url: "https://github.com/acme/widget/pull/7" });
    } else if (req.url.endsWith("/pulls/12/diff")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("diff --git a/app.js b/app.js\n+console.log('ok');\n");
    } else if (req.url.endsWith("/pulls/12")) {
      respond(res, {
        number: 12,
        title: "Add widget",
        additions: 2,
        deletions: 0,
        changed_files: 1,
        head: { ref: "feature" },
        base: { ref: "main" },
        diff_url: `http://${req.headers.host}/repos/acme/widget/pulls/12/diff`,
        html_url: "https://github.com/acme/widget/pull/12",
      });
    } else if (req.url.includes("/actions/runs")) {
      respond(res, { workflow_runs: [{ name: "ci", status: "completed", conclusion: "success", head_branch: "main" }] });
    } else if (req.url.startsWith("/user/repos")) {
      respond(res, [{ full_name: "acme/widget", language: "JavaScript", stargazers_count: 3, pushed_at: "2026-09-11T12:00:00Z" }]);
    } else if (req.url.endsWith("/repos/acme/widget")) {
      respond(res, { full_name: "acme/widget", default_branch: "main", stargazers_count: 3 });
    } else if (req.url.endsWith("/user")) {
      userHits++;
      respond(res, {
        login: "mayank-test",
        name: "Mayank Test",
        public_repos: 3,
        followers: 7,
        html_url: "https://github.com/mayank-test",
      });
    } else if (req.url.endsWith("/models")) {
      respond(res, { data: [{ id: "mock-model" }] });
    } else {
      respond(res, []);
    }
  });
});

function runCli(args, cwd, env, timeoutMs, stdinData) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const child = spawn("node", [CLI, ...args], { cwd, env });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs || 30000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout: out, stderr: err });
    });
    if (stdinData != null) child.stdin.end(stdinData);
  });
}

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-test-"));
  const env = {
    ...process.env,
    GITMANCER_AI_BASE: `http://127.0.0.1:${port}/v1`,
    GITMANCER_AI_KEY: "test-ai-key",
    GITMANCER_AI_MODEL: "mock-model",
    GITMANCER_GITHUB_TOKEN: "gh_test_token_abc",
    GITMANCER_GH_BASE: `http://127.0.0.1:${port}`,
  };

  console.log("→ agent tool loop (ask)");
  let r = await runCli(["ask", "please create hello.txt", "--yolo"], tmp, env);
  check("ask exits 0", r.status === 0);
  const hello = path.join(tmp, "hello.txt");
  check("hello.txt created by agent", fs.existsSync(hello));
  if (fs.existsSync(hello)) {
    check("hello.txt content correct", fs.readFileSync(hello, "utf8") === "hello from gitmancer");
  }
  check("two AI calls made (tool_call → final)", aiCalls >= 2);
  check("streamed answer reaches stdout", /Done — handled hello\.txt\./.test(r.stdout || ""));
  check("usage line printed", /usage: \d+ AI calls? · ~\d+ tokens/.test(r.stdout || ""));

  console.log("→ fix command (agent auto-repairs a failing command)");
  const fixDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-fix-"));
  r = await runCli(["fix", "--yolo", "node --check app.js"], fixDir, env);
  check("fix exits 0", r.status === 0);
  check("app.js written by fix agent", fs.existsSync(path.join(fixDir, "app.js")));
  check("FIXED verdict shown", /FIXED/.test(r.stdout || ""));

  console.log("→ pr command (confirm-gated GitHub mutation)");
  const prDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-pr-"));
  r = await runCli(["pr", "--repo", "acme/widget", "--title", "Add widget", "--body", "Does things", "--base", "main", "--head", "feature", "--yolo"], prDir, env);
  check("pr exits 0", r.status === 0);
  check("pr number shown", /#7/.test(r.stdout || ""));
  check("pr url shown", /acme\/widget\/pull\/7/.test(r.stdout || ""));

  console.log("→ whoami");
  r = await runCli(["whoami"], tmp, env);
  check("whoami exits 0", r.status === 0);
  check("whoami shows login", /mayank-test/.test(r.stdout || ""));

  console.log("→ secret hygiene");
  r = await runCli(["config"], tmp, env);
  check("config exits 0", r.status === 0);
  const allOut = (r.stdout || "") + (r.stderr || "");
  check("github token never printed", !allOut.includes("gh_test_token_abc"));
  check("ai key never printed", !allOut.includes("test-ai-key"));

  console.log("→ deny flow (confirmation gate)");
  const denyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-deny-"));
  r = await runCli(["ask", "make hello.txt"], denyDir, env, 30000, "n\n");
  check("deny run exits 0 (model told to move on)", r.status === 0);
  check("write denied — no file created", !fs.existsSync(path.join(denyDir, "hello.txt")));
  check("denial fed back to model", /DENIED/.test(r.stdout || ""));

  console.log("→ GitHub GET cache (two identical calls, one server hit)");
  const before = userHits;
  r = await runCli(["ask", "cache test", "--yolo"], tmp, env);
  check("cache ask exits 0", r.status === 0);
  check("second identical GET served from cache", userHits - before === 1);

  console.log("→ retry on transient AI error (500 → 200)");
  r = await runCli(["ask", "retry test", "--yolo"], tmp, env);
  check("retry ask exits 0", r.status === 0);
  check("recovered after 500 — final answer shown", /retry ok/.test(r.stdout || ""));
  check("server saw the retried request", retryTrips >= 1);

  console.log("→ parallel tool dispatch (read-only batch runs concurrently)");
  const paraDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-para-"));
  fs.writeFileSync(path.join(paraDir, "a.txt"), "AAA content");
  fs.writeFileSync(path.join(paraDir, "b.txt"), "BBB content");
  r = await runCli(["ask", "parallel test", "--yolo"], paraDir, env);
  check("parallel ask exits 0", r.status === 0);
  check("parallel tag shown", /\(parallel\)/.test(r.stdout || ""));
  check("all three reads executed", /AAA content/.test(r.stdout || "") && /BBB content/.test(r.stdout || ""));
  check("result order preserved (AAA before BBB)", (r.stdout || "").indexOf("AAA content") < (r.stdout || "").indexOf("BBB content"));
  check("final answer after parallel batch", /Done — parallel reads complete\./.test(r.stdout || ""));

  console.log("→ mixed batch: mutating tool stays gated next to read-only ones");
  const mixDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-mix-"));
  fs.writeFileSync(path.join(mixDir, "ok.txt"), "fine content");
  r = await runCli(["ask", "mixed test"], mixDir, env, 30000, "n\n");
  check("mixed run exits 0 (deny handled)", r.status === 0);
  check("read-only call still executed", /fine content/.test(r.stdout || ""));
  check("mutating call was gated", /DENIED/.test(r.stdout || ""));
  check("write denied — no file created", !fs.existsSync(path.join(mixDir, "bad.txt")));
  check("final answer after mixed batch", /Done — mixed handled\./.test(r.stdout || ""));

  console.log("→ memory: GITMANCER.md auto-loaded into the system prompt");
  const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-mem-"));
  fs.writeFileSync(path.join(memDir, "GITMANCER.md"), "Use pnpm. RULE-MARKER-123 always run tests before commit.");
  r = await runCli(["ask", "memory test", "--yolo"], memDir, env);
  check("memory ask exits 0", r.status === 0);
  check("GITMANCER.md content reached system prompt", /MEMORY-OK/.test(r.stdout || ""));
  check("memory miss not reported", !/MEMORY-MISS/.test(r.stdout || ""));
  r = await runCli(["memory"], tmp, env);
  check("memory cmd exits 0", r.status === 0);
  check("memory cmd creates template", fs.existsSync(path.join(tmp, "GITMANCER.md")) && /Created GITMANCER\.md/.test(r.stdout || ""));

  console.log("→ ask --verify: file:line receipts checked against the worktree");
  const verDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-verify-"));
  fs.writeFileSync(path.join(verDir, "calc.js"), "function add(a, b) {\n  return a + b;\n}\n");
  r = await runCli(["ask", "receipts verify test", "--verify", "--yolo"], verDir, env);
  check("verify ask exits 0", r.status === 0);
  check("receipt verdict printed", /receipts: 2 cited — 1 verified, 1 broken/.test(r.stdout || ""));
  check("broken receipt named", /✗.*missing\.js:9 — file not found/.test(r.stdout || ""));
  check("only the broken receipt flagged", ((r.stdout || "").match(/✗/g) || []).length === 1);

  console.log("→ undo: journal reverts the agent's file change");
  const undoHome = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-undohome-"));
  const undoEnv = { ...env, HOME: undoHome };
  const undoDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-undo-"));
  fs.writeFileSync(path.join(undoDir, "data.txt"), "ORIGINAL");
  r = await runCli(["ask", "undo test", "--yolo"], undoDir, undoEnv);
  check("undo ask exits 0", r.status === 0);
  check("agent overwrote data.txt", fs.existsSync(path.join(undoDir, "data.txt")) && fs.readFileSync(path.join(undoDir, "data.txt"), "utf8") === "OVERWRITTEN");
  r = await runCli(["undo"], undoDir, undoEnv);
  check("undo exits 0", r.status === 0);
  check("undo restored previous content", fs.existsSync(path.join(undoDir, "data.txt")) && fs.readFileSync(path.join(undoDir, "data.txt"), "utf8") === "ORIGINAL");
  check("undo reported restored", /restored/.test(r.stdout || ""));

  console.log("→ batch_edit tool: multi-replacement in one call");
  const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-batch-"));
  fs.writeFileSync(path.join(batchDir, "app.js"), "var a = 1;\nvar sum = a + 2;\n");
  r = await runCli(["ask", "batch test", "--yolo"], batchDir, env);
  check("batch ask exits 0", r.status === 0);
  check("batch_edit applied replacement", fs.readFileSync(path.join(batchDir, "app.js"), "utf8") === "var b = 1;\nvar sum = b + 2;\n");
  check("batch final answer shown", /batch done\./.test(r.stdout || ""));

  console.log("→ watch: green on the first run (no agent loop)");
  r = await runCli(["watch", "node -e 'process.exit(0)'"], tmp, env);
  check("watch pass exits 0", r.status === 0);
  check("watch reports first-run green", /green on the first run/.test(r.stdout || ""));

  console.log("→ watch: auto-fix loop turns red into green");
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-watch-"));
  r = await runCli(["watch", "test -f hello.txt", "--max", "3", "--yolo"], watchDir, env);
  check("watch auto-fix exits 0", r.status === 0);
  check("watch fixed then green", /GREEN after \d+ fix rounds?/.test(r.stdout || ""));
  check("watch created the missing file", fs.existsSync(path.join(watchDir, "hello.txt")));

  console.log("→ prbot --once: reviews an open PR, remembers, skips on re-run");
  const botHome = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-bot-"));
  const botEnv = { ...env, HOME: botHome };
  r = await runCli(["prbot", "--repo", "acme/widget", "--once", "--yolo"], tmp, botEnv);
  check("prbot exits 0", r.status === 0);
  check("prbot reviewed PR #7", /reviewing #7/.test(r.stdout || ""));
  check("prbot posted the review", /review posted on #7/.test(r.stdout || ""));
  r = await runCli(["prbot", "--repo", "acme/widget", "--once", "--yolo"], tmp, botEnv);
  check("prbot second pass exits 0", r.status === 0);
  check("prbot skips already-reviewed PR", !/reviewing #7/.test(r.stdout || "") && /no new pull requests/.test(r.stdout || ""));

  console.log("→ budget: agent loop stops when the token cap is hit");
  r = await runCli(["ask", "please create hello2.txt", "--yolo", "--budget", "50"], tmp, env);
  check("budget run exits 0", r.status === 0);
  check("budget stop reported", /--budget reached/.test((r.stdout || "") + (r.stderr || "")));

  console.log("→ status --json");
  r = await runCli(["status", "--repo", "acme/widget", "--json"], tmp, env);
  check("status exits 0", r.status === 0);
  let j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {}
  check("status json parses cleanly", !!j);
  check("status shows repo + CI conclusion", !!(j && j.repo === "acme/widget" && j.github && j.github.lastRun && j.github.lastRun.conclusion === "success"));

  console.log("→ sweep --json");
  r = await runCli(["sweep", "--json"], tmp, env);
  check("sweep exits 0", r.status === 0);
  j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {}
  check("sweep lists repos with open counts", Array.isArray(j) && j.length >= 1 && j[0].repo === "acme/widget");

  console.log("→ review (AI code review of a PR)");
  r = await runCli(["review", "12", "--repo", "acme/widget"], tmp, env);
  check("review exits 0", r.status === 0);
  check("review verdict shown", /APPROVE/.test(r.stdout || ""));

  console.log("→ doctor");
  r = await runCli(["doctor"], tmp, env);
  check("doctor exits 0", r.status === 0);
  check("doctor reports GitHub auth", /authenticated as mayank-test/.test(r.stdout || ""));
  check("doctor keeps secrets masked", !((r.stdout || "") + (r.stderr || "")).includes("gh_test_token_abc"));

  console.log("→ pr list / close / merge");
  r = await runCli(["pr", "list", "--repo", "acme/widget", "--json"], tmp, env);
  check("pr list exits 0", r.status === 0);
  j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {}
  check("pr list json shows #7", Array.isArray(j) && j[0] && j[0].number === 7);
  r = await runCli(["pr", "close", "7", "--repo", "acme/widget", "--yolo"], tmp, env);
  check("pr close exits 0", r.status === 0);
  check("pr close confirmed", /closed PR #7/.test(r.stdout || ""));
  r = await runCli(["pr", "merge", "7", "--repo", "acme/widget", "--squash", "--yolo"], tmp, env);
  check("pr merge exits 0", r.status === 0);
  check("pr merge confirmed", /merged #7/.test(r.stdout || ""));

  console.log("→ issue reopen");
  r = await runCli(["issue", "acme/widget", "reopen", "5"], tmp, env);
  check("issue reopen exits 0", r.status === 0);
  check("issue reopen confirmed", /reopened #5/.test(r.stdout || ""));

  console.log("→ repos --json / whoami --json");
  r = await runCli(["repos", "--json"], tmp, env);
  check("repos --json exits 0", r.status === 0);
  j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {}
  check("repos --json lists acme/widget", Array.isArray(j) && j[0] && j[0].name === "acme/widget");
  r = await runCli(["whoami", "--json"], tmp, env);
  check("whoami --json exits 0", r.status === 0);
  j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {}
  check("whoami --json login", !!(j && j.login === "mayank-test"));

  console.log("→ ship --no-push");
  const shipDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-ship-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: shipDir });
  spawnSync("git", ["config", "user.email", "t@t.local"], { cwd: shipDir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: shipDir });
  fs.writeFileSync(path.join(shipDir, "f.txt"), "x");
  r = await runCli(["ship", "test: local commit", "--no-push"], shipDir, env);
  check("ship --no-push exits 0", r.status === 0);
  check("ship reports no push", /not pushing/.test(r.stdout || ""));
  const committed = spawnSync("git", ["log", "--oneline", "-1"], { cwd: shipDir, encoding: "utf8" }).stdout || "";
  check("commit created locally", /test: local commit/.test(committed));

  console.log("→ changelog + release");
  const relDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-rel-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: relDir });
  spawnSync("git", ["config", "user.email", "t@t.local"], { cwd: relDir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: relDir });
  fs.writeFileSync(path.join(relDir, "f.txt"), "one");
  spawnSync("git", ["add", "."], { cwd: relDir });
  spawnSync("git", ["commit", "-m", "feat: first thing"], { cwd: relDir });
  fs.writeFileSync(path.join(relDir, "f.txt"), "two");
  spawnSync("git", ["add", "."], { cwd: relDir });
  spawnSync("git", ["commit", "-m", "fix: crash on start"], { cwd: relDir });
  fs.writeFileSync(path.join(relDir, "package.json"), JSON.stringify({ name: "rel-fixture", version: "1.2.3" }, null, 2) + "\n");
  spawnSync("git", ["add", "."], { cwd: relDir });
  spawnSync("git", ["commit", "-m", "chore: add package"], { cwd: relDir });

  r = await runCli(["changelog"], relDir, env);
  check("changelog exits 0", r.status === 0);
  check("changelog prints AI notes", /MOCK-NOTE/.test(r.stdout || ""));

  r = await runCli(["changelog", "--write", "--yolo"], relDir, env);
  check("changelog --write exits 0", r.status === 0);
  const clText1 = fs.existsSync(path.join(relDir, "CHANGELOG.md")) ? fs.readFileSync(path.join(relDir, "CHANGELOG.md"), "utf8") : "";
  check("changelog --write creates CHANGELOG.md", /MOCK-NOTE/.test(clText1) && /## Unreleased/.test(clText1));

  r = await runCli(["release", "patch", "--no-push", "--yolo"], relDir, env);
  check("release --no-push exits 0", r.status === 0);
  let pkgNow = {};
  try { pkgNow = JSON.parse(fs.readFileSync(path.join(relDir, "package.json"), "utf8")); } catch {}
  check("release bumps version to 1.2.4", pkgNow.version === "1.2.4");
  const relLog = spawnSync("git", ["log", "--oneline", "-1"], { cwd: relDir, encoding: "utf8" }).stdout || "";
  check("release commit created", /chore\(release\): v1\.2\.4/.test(relLog));
  const relTags = spawnSync("git", ["tag", "--list"], { cwd: relDir, encoding: "utf8" }).stdout || "";
  check("release tag created", /v1\.2\.4/.test(relTags));
  const clText2 = fs.existsSync(path.join(relDir, "CHANGELOG.md")) ? fs.readFileSync(path.join(relDir, "CHANGELOG.md"), "utf8") : "";
  check("release writes CHANGELOG section", /## \[1\.2\.4\]/.test(clText2));
  check("release notes reach CHANGELOG", /MOCK-NOTE/.test(clText2));

  r = await runCli(["release", "banana"], relDir, env);
  check("release rejects invalid bump", r.status !== 0);

  console.log("→ secscan: finds planted secrets, redacts, exits 1");
  const secDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-sec-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: secDir });
  spawnSync("git", ["config", "user.email", "t@t.local"], { cwd: secDir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: secDir });
  const FAKE_GH = "ghp_" + "A".repeat(32) + "1111";
  const FAKE_AWS = "AKIA" + "B7C8D9E0" + "F1A2B3C4";
  fs.writeFileSync(path.join(secDir, "config.js"), `const token = "${FAKE_GH}";\nconst fine = "clean";\n`);
  fs.writeFileSync(path.join(secDir, "creds.txt"), `aws = ${FAKE_AWS}\n`);
  spawnSync("git", ["add", "."], { cwd: secDir });
  spawnSync("git", ["commit", "-m", "fix: add config"], { cwd: secDir });
  r = await runCli(["secscan"], secDir, env);
  check("secscan detects planted secrets (exit 1)", r.status === 1);
  check("secscan names rules + files", /github-token/.test(r.stdout || "") && /aws-key/.test(r.stdout || ""));
  check("secscan redacts the secret value", !((r.stdout || "") + (r.stderr || "")).includes(FAKE_GH));
  r = await runCli(["secscan", "--json"], secDir, env);
  j = null;
  try { j = JSON.parse(r.stdout); } catch {}
  check("secscan --json parses with findings", !!(j && j.count === 2 && Array.isArray(j.findings)));
  fs.writeFileSync(path.join(secDir, "clean.txt"), "nothing here\n");
  spawnSync("git", ["add", "clean.txt"], { cwd: secDir });
  r = await runCli(["secscan", "--staged"], secDir, env);
  check("secscan --staged clean exits 0", r.status === 0 && /clean — no secrets/.test(r.stdout || ""));

  console.log("→ testgen: AI writes unit tests (preview vs --yolo write)");
  const tgDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-tg-"));
  fs.writeFileSync(path.join(tgDir, "calc.js"), "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n");
  r = await runCli(["testgen", "calc.js"], tgDir, env);
  check("testgen preview exits 0", r.status === 0);
  check("testgen preview prints tests, writes nothing", /MOCK-TEST generated/.test(r.stdout || "") && !fs.existsSync(path.join(tgDir, "calc.test.js")));
  r = await runCli(["testgen", "calc.js", "--yolo"], tgDir, env);
  check("testgen --yolo exits 0", r.status === 0);
  const tgFile = path.join(tgDir, "calc.test.js");
  check("testgen --yolo writes test file", fs.existsSync(tgFile) && /MOCK-TEST generated/.test(fs.readFileSync(tgFile, "utf8")));
  check("testgen strips markdown fences", !fs.readFileSync(tgFile, "utf8").includes("```"));

  console.log("→ explain: file / diff / command modes");
  const exDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-ex-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: exDir });
  spawnSync("git", ["config", "user.email", "t@t.local"], { cwd: exDir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: exDir });
  fs.writeFileSync(path.join(exDir, "app.js"), "console.log('v1');\n");
  spawnSync("git", ["add", "."], { cwd: exDir });
  spawnSync("git", ["commit", "-m", "feat: v1"], { cwd: exDir });
  fs.writeFileSync(path.join(exDir, "app.js"), "console.log('v2');\n");
  spawnSync("git", ["add", "."], { cwd: exDir });
  spawnSync("git", ["commit", "-m", "feat: v2"], { cwd: exDir });
  r = await runCli(["explain", "HEAD~1..HEAD"], exDir, env);
  check("explain diff exits 0", r.status === 0);
  check("explain diff answers", /EXPLAIN-OK \(diff\)/.test(r.stdout || ""));
  r = await runCli(["explain", "app.js"], exDir, env);
  check("explain file exits 0", r.status === 0);
  check("explain file answers", /EXPLAIN-OK \(file\)/.test(r.stdout || ""));
  r = await runCli(["explain", "git rebase --onto"], exDir, env);
  check("explain command exits 0", r.status === 0);
  check("explain command answers", /EXPLAIN-OK \(cmd\)/.test(r.stdout || ""));

  console.log("→ fleet: multi-repo status / secscan / run / json");
  const fleetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-fleet-"));
  for (const name of ["fleet-a", "fleet-b"]) {
    const d = path.join(fleetRoot, name);
    fs.mkdirSync(d, { recursive: true });
    spawnSync("git", ["init", "-b", "main"], { cwd: d });
    spawnSync("git", ["config", "user.email", "t@t.local"], { cwd: d });
    spawnSync("git", ["config", "user.name", "t"], { cwd: d });
    fs.writeFileSync(path.join(d, "f.txt"), "x\n");
    spawnSync("git", ["add", "."], { cwd: d });
    spawnSync("git", ["commit", "-m", "init"], { cwd: d });
  }
  const FAKE_PW = "super-secret-pass" + "word-123";
  fs.writeFileSync(path.join(fleetRoot, "fleet-a", "leak.js"), `const password = "${FAKE_PW}";\n`);
  spawnSync("git", ["add", "leak.js"], { cwd: path.join(fleetRoot, "fleet-a") });
  r = await runCli(["fleet", "status", "--root", fleetRoot, "--json"], fleetRoot, env);
  check("fleet status exits 0", r.status === 0);
  j = null;
  try { j = JSON.parse(r.stdout); } catch {}
  check("fleet status --json lists both repos sorted", Array.isArray(j) && j.map((x) => x.repo).join(",") === "fleet-a,fleet-b");
  check("fleet status shows branch", !!(j && j[0] && j[0].branch === "main"));
  r = await runCli(["fleet", "secscan", "--root", fleetRoot], fleetRoot, env);
  check("fleet secscan exits 1 (finding in fleet-a)", r.status === 1);
  check("fleet secscan reports both repos", /fleet-a/.test(r.stdout || "") && /fleet-b/.test(r.stdout || ""));
  r = await runCli(["fleet", "run", "echo hi", "--root", fleetRoot], fleetRoot, env);
  check("fleet run exits 0", r.status === 0);
  check("fleet run executed per repo", (r.stdout || "").split("hi").length - 1 >= 2);
  r = await runCli(["fleet", "banana", "--root", fleetRoot], fleetRoot, env);
  check("fleet rejects unknown action", r.status !== 0);

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed.length) {
    console.error(`\nFAILED: ${failed.length} check(s)`);
    process.exit(1);
  }
  console.log("\nALL TESTS PASSED ✅");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
