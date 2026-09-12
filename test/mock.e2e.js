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
let labelPosts = 0;
let plugCalls = 0;
let diceInTools = false;
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
      } else if (/\[gitmancer triage\]/.test(String((((reqBody.messages || [])[0]) || {}).content || ""))) {
        // triage flow: deterministic JSON classification
        message = { role: "assistant", content: '{"priority":"P1","type":"bug","label":"bug · P1","rationale":"mock crash on start"}' };
      } else if (/receipts verify test/.test(String(lastUser))) {
        // ask --verify flow: cite one real file:line and one broken reference
        message = { role: "assistant", content: "The adder lives in `calc.js:1`; the old helper was `missing.js:9`." };
      } else if (/hello2/.test(String(lastUser))) {
        // budget flow: always demand a write so the budget check trips on the next step
        message = { role: "assistant", content: null, tool_calls: [{ id: "bud1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "hello2.txt", content: "budget" }) } }] };
      } else if (/plugin tool test/.test(String(lastUser))) {
        // plugin flow: 1st call → plugin-defined dice tool, 2nd → final text
        plugCalls++;
        diceInTools = diceInTools || (reqBody.tools || []).some((tl) => tl.function && tl.function.name === "dice");
        message =
          plugCalls % 2 === 1
            ? { role: "assistant", content: null, tool_calls: [{ id: "plug_1", type: "function", function: { name: "dice", arguments: JSON.stringify({ sides: 6 }) } }] }
            : { role: "assistant", content: "Plugin dice rolled — custom tools work end to end." };
      } else if (/^\[gitmancer plan\]/.test(String((((reqBody.messages || [])[0]) || {}).content || ""))) {
        // plan flow: deterministic JSON plan with one shell step + one agent step
        message = {
          role: "assistant",
          content:
            'Here is the plan:\n```json\n{"title":"Demo plan","steps":[{"title":"write the marker","detail":"echo a marker file","cmd":"echo plan-step-ok > plan-step.txt"},{"title":"verify","detail":"cat the marker file","cmd":"cat plan-step.txt"}]}\n```',
        };
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
    } else if (req.url.startsWith("/repos/acme/widget/issues?")) {
      respond(res, [
        { number: 101, title: "Crash on start", body: "TypeError: cannot read property x of undefined", user: { login: "maya" } },
        { number: 102, title: "Add dark mode", body: "It would be nice to have a dark theme.", user: { login: "maya" }, pull_request: { url: "http://x" } },
        { number: 103, title: "Docs unclear", body: "README step 3 is confusing.", user: { login: "maya" } },
      ]);
    } else if (req.method === "POST" && /\/repos\/acme\/widget\/issues\/\d+\/labels$/.test(req.url)) {
      labelPosts++;
      respond(res, [{ name: "bug · P1" }]);
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

  console.log("→ triage: AI classifies open issues, --apply labels them");
  r = await runCli(["triage", "acme/widget", "--json"], tmp, env);
  check("triage exits 0", r.status === 0);
  j = null;
  try { j = JSON.parse(r.stdout); } catch {}
  check("triage --json filters PRs and classifies", Array.isArray(j) && j.length === 2 && j[0].number === 101 && j[0].priority === "P1");
  r = await runCli(["triage", "acme/widget", "--apply", "--yolo"], tmp, env);
  check("triage --apply exits 0", r.status === 0);
  check("triage labeled the issues", /labeled #101/.test(r.stdout || "") && /labeled #103/.test(r.stdout || ""));
  check("labels POSTed to GitHub", labelPosts >= 2);
  r = await runCli(["triage", "acme/widget"], tmp, env);
  check("triage dry run says so", /dry run/.test(r.stdout || ""));

  console.log("→ hook installer: managed pre-commit block, idempotent, uninstallable");
  const hkDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-hook-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: hkDir });
  r = await runCli(["hook", "install", "pre-commit", "--yolo"], hkDir, env);
  check("hook install exits 0", r.status === 0);
  const hp = path.join(hkDir, ".git", "hooks", "pre-commit");
  check("pre-commit hook created with secscan", fs.existsSync(hp) && /gitmancer secscan --staged/.test(fs.readFileSync(hp, "utf8")));
  r = await runCli(["hook", "install", "pre-commit", "--yolo"], hkDir, env);
  const hookText = fs.readFileSync(hp, "utf8");
  check("hook install is idempotent (single block)", (hookText.match(/gitmancer hook >>>/g) || []).length === 1);
  check("hook file is executable", !!(fs.statSync(hp).mode & 0o111));
  r = await runCli(["hook", "list"], hkDir, env);
  check("hook list shows managed hook", /pre-commit/.test(r.stdout || "") && /gitmancer-managed/.test(r.stdout || ""));
  r = await runCli(["hook", "uninstall", "pre-commit"], hkDir, env);
  check("hook uninstall exits 0", r.status === 0);
  check("uninstall removed the gitmancer-only hook", !fs.existsSync(hp));
  r = await runCli(["hook", "install", "banana"], hkDir, env);
  check("hook rejects unknown hook name", r.status !== 0);

  console.log("→ plugin system (#1 #11): scaffold, command, agent tool, list, remove");
  const plugHome = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-plug-"));
  const plugEnv = { ...env, HOME: plugHome };
  r = await runCli(["plugin", "list"], tmp, plugEnv);
  check("plugin list empty state exits 0", r.status === 0);
  check("plugin list suggests scaffold", /plugin new/.test(r.stdout || ""));
  r = await runCli(["plugin", "new", "hello"], tmp, plugEnv);
  check("plugin new scaffolds file", r.status === 0 && fs.existsSync(path.join(plugHome, ".gitmancer", "plugins", "hello.js")));
  r = await runCli(["plugin", "new", "hello"], tmp, plugEnv);
  check("plugin new refuses overwrite without --force", r.status !== 0);
  r = await runCli(["hello"], tmp, plugEnv);
  check("plugin command runs", r.status === 0 && /hello from a plugin/.test(r.stdout || ""));
  r = await runCli(["hello", "--loud"], tmp, plugEnv);
  check("plugin command receives flags", /HELLO FROM A PLUGIN/.test(r.stdout || ""));
  r = await runCli(["help"], tmp, plugEnv);
  check("help lists PLUGINS section", /PLUGINS/.test(r.stdout || "") && /hello \[--loud\]/.test(r.stdout || ""));
  r = await runCli(["plugin", "list", "--json"], tmp, plugEnv);
  let pj = null;
  try { pj = JSON.parse(r.stdout); } catch {}
  check("plugin list --json parses", !!pj && Array.isArray(pj.plugins) && pj.plugins.length === 1 && pj.plugins[0].tools === 1);
  const plugBefore = aiCalls;
  r = await runCli(["ask", "plugin tool test", "--yolo"], tmp, plugEnv);
  check("ask with plugin tool exits 0", r.status === 0);
  check("plugin tool schema reached the AI", diceInTools === true);
  check("plugin tool executed by agent", /rolled \d+ \(d6\)/.test(r.stdout || ""));
  check("plugin flow used two AI calls", aiCalls - plugBefore >= 2);
  r = await runCli(["plugin", "remove", "hello", "--yolo"], tmp, plugEnv);
  check("plugin remove exits 0", r.status === 0);
  check("plugin file deleted", !fs.existsSync(path.join(plugHome, ".gitmancer", "plugins", "hello.js")));

  console.log("→ MCP server mode (#2 #10): initialize, tools/list, tools/call over stdio JSON-RPC");
  {
    const mcpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-mcp-"));
    spawnSync("git", ["init", "-b", "main"], { cwd: mcpDir });
    spawnSync("git", ["config", "user.email", "t@t.local"], { cwd: mcpDir });
    spawnSync("git", ["config", "user.name", "t"], { cwd: mcpDir });
    const FAKE_MCP = "ghp_" + "M".repeat(32) + "2222";
    fs.writeFileSync(path.join(mcpDir, "note.txt"), "hello from mcp\n");
    fs.writeFileSync(path.join(mcpDir, "leak.js"), `const t = "${FAKE_MCP}";\n`);
    spawnSync("git", ["add", "."], { cwd: mcpDir });
    const child = spawn(process.execPath, [CLI, "mcp"], { cwd: mcpDir, env, stdio: ["pipe", "pipe", "pipe"] });
    const lineQ = [];
    let lineWait = null;
    let mbuf = "";
    child.stdout.on("data", (d) => {
      mbuf += d.toString();
      let idx;
      while ((idx = mbuf.indexOf("\n")) !== -1) {
        const out = mbuf.slice(0, idx);
        mbuf = mbuf.slice(idx + 1);
        if (lineWait) {
          const r = lineWait;
          lineWait = null;
          r(out);
        } else lineQ.push(out);
      }
    });
    const nextLine = () => (lineQ.length ? Promise.resolve(lineQ.shift()) : new Promise((res) => (lineWait = res)));
    const rpc = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    let m;
    rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    m = JSON.parse(await nextLine());
    check("mcp initialize returns protocol + serverInfo", m.result && m.result.protocolVersion === "2024-11-05" && m.result.serverInfo.name === "gitmancer");
    rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    m = JSON.parse(await nextLine());
    const mcpNames = (m.result.tools || []).map((x) => x.name);
    check("mcp tools/list exposes 5 tools", mcpNames.length === 5);
    check("mcp tools/list has schemas", m.result.tools.every((x) => x.inputSchema && x.inputSchema.type === "object"));
    rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_files", arguments: { path: "." } } });
    m = JSON.parse(await nextLine());
    check("mcp list_files works", m.result && m.result.content[0].text.includes("note.txt"));
    rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "run_cmd", arguments: { command: "echo mcp-ok" } } });
    m = JSON.parse(await nextLine());
    check("mcp read-only run_cmd allowed", m.result && !m.result.isError && /mcp-ok/.test(m.result.content[0].text));
    rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "run_cmd", arguments: { command: "rm note.txt" } } });
    m = JSON.parse(await nextLine());
    check("mcp mutating run_cmd refused by default", m.result && m.result.isError && /GITMANCER_MCP_ALLOW_RUN/.test(m.result.content[0].text));
    rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "secscan", arguments: {} } });
    m = JSON.parse(await nextLine());
    let scan = null;
    try { scan = JSON.parse(m.result.content[0].text); } catch {}
    check("mcp secscan finds planted secret", scan && scan.findings && scan.findings.length >= 1);
    check("mcp secscan redacts secret value", scan && !JSON.stringify(scan).includes(FAKE_MCP));
    rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read_file", arguments: { path: "note.txt" } } });
    m = JSON.parse(await nextLine());
    check("mcp read_file works", m.result && /hello from mcp/.test(m.result.content[0].text));
    rpc({ jsonrpc: "2.0", id: 8, method: "no/such/method" });
    m = JSON.parse(await nextLine());
    check("mcp unknown method → -32601", m.error && m.error.code === -32601);
    rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "banana", arguments: {} } });
    m = JSON.parse(await nextLine());
    check("mcp unknown tool → -32602", m.error && m.error.code === -32602);
    rpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "repo_status", arguments: {} } });
    m = JSON.parse(await nextLine());
    check("mcp repo_status shows branch", m.result && !m.result.isError && /branch: main/.test(m.result.content[0].text));
    child.stdin.end();
    await new Promise((res) => child.once("exit", res));
    check("mcp exits cleanly on stdin close", true);
  }

  console.log("→ shell completions (#3): bash/zsh/fish scripts + live bash resolution");
  r = await runCli(["completions", "bash"], tmp, env);
  check("completions bash exits 0", r.status === 0);
  check("bash script has complete -F", /complete -F _gitmancer_completions gitmancer/.test(r.stdout || ""));
  check("bash script lists every command", ["secscan", "triage", "fleet", "plugin", "mcp", "completions"].every((c) => (r.stdout || "").includes(c)));
  r = await runCli(["completions", "zsh"], tmp, env);
  check("zsh script has #compdef", /#compdef gitmancer/.test(r.stdout || "") && /compdef _gitmancer gitmancer/.test(r.stdout || ""));
  r = await runCli(["completions", "fish"], tmp, env);
  check("fish script uses complete -c", /complete -c gitmancer/.test(r.stdout || "") && /__fish_seen_subcommand_from secscan/.test(r.stdout || ""));
  r = await runCli(["completions", "tcsh"], tmp, env);
  check("unknown shell rejected", r.status !== 0 && /bash\|zsh\|fish/.test((r.stderr || "") + (r.stdout || "")));
  {
    // live check: source the bash script and complete "sec<tab>"
    const bashScript = (await runCli(["completions", "bash"], tmp, env)).stdout;
    fs.writeFileSync("/tmp/_gitmancer_test_completion.sh", bashScript);
    const probe = spawnSync("bash", [
      "-c",
      `source /tmp/_gitmancer_test_completion.sh; COMP_WORDS=(gitmancer sec); COMP_CWORD=1; _gitmancer_completions; echo "\${COMPREPLY[*]}"`,
    ]);
    check("live bash completion resolves secscan", probe.status === 0 && /secscan/.test(probe.stdout || ""));
    const probe2 = spawnSync("bash", ["-c", `source /tmp/_gitmancer_test_completion.sh; COMP_WORDS=(gitmancer secscan --); COMP_CWORD=2; _gitmancer_completions; echo "\${COMPREPLY[*]}"`]);
    check("live bash completion offers secscan flags", probe2.status === 0 && /--staged/.test(probe2.stdout || "") && /--json/.test(probe2.stdout || ""));
    fs.rmSync("/tmp/_gitmancer_test_completion.sh", { force: true });
  }

  console.log("→ session record & replay (#4): asciinema v2 cast round-trip");
  {
    const recHome = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-rec-"));
    const recEnv = { ...env, HOME: recHome };
    r = await runCli(["record", "echo hello-record", "--yolo"], tmp, recEnv);
    check("record echo exits 0", r.status === 0);
    check("record passes output through live", /hello-record/.test(r.stdout || ""));
    check("record points at saved session", /session saved/.test(r.stdout || ""));
    const sessDir = path.join(recHome, ".gitmancer", "sessions");
    const casts = fs.existsSync(sessDir) ? fs.readdirSync(sessDir).filter((f) => f.endsWith(".cast")) : [];
    check("record wrote one .cast into sessions dir", casts.length === 1);
    let castLines = [];
    if (casts.length) castLines = fs.readFileSync(path.join(sessDir, casts[0]), "utf8").split("\n").filter(Boolean);
    let hdr = null;
    let oEvents = 0;
    for (const l of castLines) {
      try {
        const j = JSON.parse(l);
        if (Array.isArray(j) && j[1] === "o") oEvents++;
        else if (j && j.version === 2) hdr = j;
      } catch {}
    }
    check("cast header is asciinema v2 with env", !!hdr && !!hdr.env && !!hdr.timestamp);
    check("cast has output events containing the text", oEvents >= 1 && castLines.some((l) => l.includes("hello-record")));
    r = await runCli(["replay", casts[0].replace(".cast", "")], tmp, recEnv);
    check("replay by session name prints recorded output", r.status === 0 && /hello-record/.test(r.stdout || ""));
    r = await runCli(["replay", "--list"], tmp, recEnv);
    check("replay --list shows the session", /\.cast/.test(r.stdout || ""));
    const outCast = path.join(recHome, "explicit.cast");
    r = await runCli(["record", "echo explicit-run", "--out", outCast, "--yolo"], tmp, recEnv);
    check("record --out writes custom path", r.status === 0 && fs.existsSync(outCast) && fs.readFileSync(outCast, "utf8").includes("explicit-run"));
    r = await runCli(["replay", outCast], tmp, recEnv);
    check("replay custom path works", r.status === 0 && /explicit-run/.test(r.stdout || ""));
    r = await runCli(["record"], tmp, recEnv);
    check("record without command fails", r.status !== 0);
    r = await runCli(["replay", "definitely-missing-xyz"], tmp, recEnv);
    check("replay of missing session fails cleanly", r.status !== 0 && /not found/.test((r.stderr || "") + (r.stdout || "")));
  }

  console.log("→ plan / execute (#6): AI plan → saved JSON → executed steps");
  {
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmancer-plan-"));
    r = await runCli(["plan", "write and verify a marker file", "--write", "plan.json"], planDir, env);
    check("plan exits 0", r.status === 0);
    check("plan renders steps", /PLAN: Demo plan/.test(r.stdout || "") && /write the marker/.test(r.stdout || ""));
    check("plan saved to plan.json", fs.existsSync(path.join(planDir, "plan.json")));
    r = await runCli(["execute", "plan.json", "--dry-run"], planDir, env);
    check("execute --dry-run skips everything", r.status === 0 && /dry run — skipped/.test(r.stdout || "") && !fs.existsSync(path.join(planDir, "plan-step.txt")));
    r = await runCli(["execute", "plan.json", "--yolo"], planDir, env);
    check("execute runs shell steps", r.status === 0 && /step 1 done/.test(r.stdout || "") && /all green/.test(r.stdout || ""));
    check("execute produced the step's file", fs.existsSync(path.join(planDir, "plan-step.txt")) && fs.readFileSync(path.join(planDir, "plan-step.txt"), "utf8").trim() === "plan-step-ok");
    r = await runCli(["execute", "missing-plan.json"], planDir, env);
    check("execute of missing plan fails cleanly", r.status !== 0 && /not found/.test((r.stderr || "") + (r.stdout || "")));
    fs.writeFileSync(path.join(planDir, "bad.json"), "{not json");
    r = await runCli(["execute", "bad.json"], planDir, env);
    check("execute of invalid JSON fails cleanly", r.status !== 0 && /bad plan JSON/.test((r.stderr || "") + (r.stdout || "")));
  }

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
