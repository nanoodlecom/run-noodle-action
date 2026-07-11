import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseLines, buildArgv } from "../scripts/run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_MJS = join(HERE, "..", "scripts", "run.mjs");
const FIXTURE = join(HERE, "fixtures", "text-llm-graph.json");

/* ---------------- unit: parseLines ---------------- */

test("parseLines splits KEY=VALUE lines, skipping blanks and #comments", () => {
  const text = "Text=a cozy ramen shop\n\n# a comment\n  n2.system=be brief\r\nk=v=with=equals\n";
  assert.deepEqual(parseLines(text), [
    "Text=a cozy ramen shop",
    "n2.system=be brief",
    "k=v=with=equals",
  ]);
});

test("parseLines returns [] for empty / undefined input", () => {
  assert.deepEqual(parseLines(""), []);
  assert.deepEqual(parseLines(undefined), []);
  assert.deepEqual(parseLines("   \n\n#only comments\n"), []);
});

test("parseLines rejects lines without =", () => {
  assert.throws(() => parseLines("no-equals-here", "inputs"), /inputs: expected KEY=VALUE/);
  assert.throws(() => parseLines("=value-without-key"), /expected KEY=VALUE/);
});

/* ---------------- unit: buildArgv ---------------- */

test("buildArgv assembles the nanoodle run command", () => {
  const argv = buildArgv({
    graph: "g.json",
    inputs: ["Text=hi", "n2.system=x"],
    sets: ["n3.size=1024x1024"],
    outDir: "out",
    timeoutMs: "60000",
    version: "0.1.1",
  });
  assert.deepEqual(argv, [
    "--yes", "nanoodle@0.1.1", "run", "g.json",
    "--input", "Text=hi", "--input", "n2.system=x",
    "--set", "n3.size=1024x1024",
    "--out", "out", "--json",
    "--timeout", "60000",
  ]);
});

test("buildArgv omits --timeout when not given", () => {
  const argv = buildArgv({ graph: "g.json", outDir: "o", version: "0.1.1" });
  assert.deepEqual(argv, ["--yes", "nanoodle@0.1.1", "run", "g.json", "--out", "o", "--json"]);
  assert.ok(!argv.includes("--timeout"));
});

/* ---------------- e2e: run.mjs against a local NanoGPT stub ---------------- */

function startStub() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.method === "POST" && req.url === "/api/v1/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "hello from mock" } }],
        x_nanogpt_pricing: { costUsd: 0.0007, remainingBalance: 4.2 },
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "stub: no route for " + req.method + " " + req.url }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test("e2e: run.mjs runs a graph via the stub and writes GITHUB_OUTPUT + out-dir", { timeout: 120000 }, async () => {
  const stub = await startStub();
  const work = await mkdtemp(join(tmpdir(), "noodle-action-"));
  const outDir = join(work, "out");
  const ghOutput = join(work, "github_output.txt");
  await writeFile(ghOutput, "");

  try {
    const child = spawn(process.execPath, [RUN_MJS], {
      cwd: join(HERE, ".."), // repo root, so npx resolves the nanoodle devDependency locally
      env: {
        ...process.env,
        INPUT_GRAPH: FIXTURE,
        INPUT_API_KEY: "test-key-123",
        INPUT_INPUTS: "n1.text=say hi to CI\n\n# comment line\n",
        INPUT_SET: "",
        INPUT_OUT_DIR: outDir,
        INPUT_TIMEOUT_MS: "30000",
        INPUT_NANOODLE_VERSION: "0.1.1",
        GITHUB_OUTPUT: ghOutput,
        NANOGPT_BASE_URL: stub.url, // the CLI honors this — zero real spend
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0, `run.mjs exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);

    // the API key must never appear in logs
    assert.ok(!stdout.includes("test-key-123"), "api key leaked to stdout");
    assert.ok(!stderr.includes("test-key-123"), "api key leaked to stderr");

    // GITHUB_OUTPUT protocol
    const gh = await readFile(ghOutput, "utf8");
    assert.match(gh, new RegExp(`^out-dir=${outDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.match(gh, /^cost-usd=0\.0007$/m);
    const resultPath = gh.match(/^result-json=(.+)$/m)?.[1];
    assert.ok(resultPath, "result-json output missing:\n" + gh);

    // result JSON landed in out-dir with the LLM text output + cost
    assert.equal(dirname(resultPath), outDir);
    await access(resultPath);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.costUsd, 0.0007);
    const values = Object.values(result.outputs);
    assert.ok(values.includes("hello from mock"), "llm text output missing: " + JSON.stringify(result.outputs));

    // the stub actually served the run, authenticated with the key we passed via env
    const chat = stub.requests.filter((r) => r.url === "/api/v1/chat/completions");
    assert.equal(chat.length, 1);
    assert.equal(chat[0].headers["authorization"], "Bearer test-key-123");
    assert.ok(chat[0].body.includes("say hi to CI"), "workflow input did not reach the API call");
  } finally {
    await stub.close();
  }
});
