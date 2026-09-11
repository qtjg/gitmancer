const http = require("http");
const { spawn } = require("child_process");
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

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url.includes("/chat/completions")) {
      aiCalls++;
      if (aiCalls % 2 === 1) {
        // odd call → request a file write (so both yolo and deny scenarios work)
        respond(res, {
          choices: [
            {
              message: {
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
              },
            },
          ],
        });
      } else {
        respond(res, {
          choices: [{ message: { role: "assistant", content: "Done — handled hello.txt." } }],
        });
      }
    } else if (req.url.endsWith("/user")) {
      respond(res, {
        login: "mayank-test",
        name: "Mayank Test",
        public_repos: 3,
        followers: 7,
        html_url: "https://github.com/mayank-test",
      });
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
