import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, access, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseLines, buildArgv, isShareRef } from "../scripts/run.mjs";

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

/* ---------------- unit: isShareRef ---------------- */

test("isShareRef accepts share links (URLs and #g=/#j=/#a= fragments)", () => {
  assert.ok(isShareRef("https://nanoodle.com/#g=H4sIAAAA"));
  assert.ok(isShareRef("http://nanoodle.com/#a=abc"));
  assert.ok(isShareRef("https://da.gd/abc123"));       // short link — still an http(s) URL
  assert.ok(isShareRef("#g=H4sIAAAA"));                // bare fragment, with leading #
  assert.ok(isShareRef("g=H4sIAAAA"));                 // bare fragment, no leading #
  assert.ok(isShareRef("#j=abc"));
  assert.ok(isShareRef("#a=abc"));
  assert.ok(isShareRef("#ga=abc"));                    // gzip+app variant
});

test("isShareRef rejects file paths and non-strings", () => {
  assert.equal(isShareRef("art/noodle-graph.json"), false);
  assert.equal(isShareRef("./graph.json"), false);
  assert.equal(isShareRef("/abs/path/graph.json"), false);
  assert.equal(isShareRef("graph.json"), false);
  assert.equal(isShareRef(""), false);
  assert.equal(isShareRef(undefined), false);
  assert.equal(isShareRef(null), false);
  assert.equal(isShareRef(42), false);
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

test("buildArgv passes a share URL through verbatim (special chars untouched)", () => {
  const url = "https://nanoodle.com/#a=H4sI_AbC-dEf&x=1&y=2";
  const argv = buildArgv({ graph: url, outDir: "out", version: "0.2.0" });
  // the graph value is argv[3], byte-identical — no encoding, no splitting on # or &
  assert.equal(argv[3], url);
  assert.deepEqual(argv, ["--yes", "nanoodle@0.2.0", "run", url, "--out", "out", "--json"]);
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

/* --------- e2e: a share URL reaches the CLI arg untouched, no exists-check ---------
 *
 * The 0.1.x CLI can't decode share URLs, so we can't round-trip one through the
 * real binary yet (that lands with nanoodle 0.2.0). Instead we shadow `npx` on
 * PATH with a tiny recorder that captures its argv and prints a valid --json
 * result. This proves the action layer: the URL is passed to the CLI verbatim,
 * the default version is 0.2.0, and nothing stats/rejects the "file" that
 * doesn't exist. Fully offline. */
test("e2e: run.mjs hands a share URL to the CLI verbatim and never stats it", { timeout: 30000, skip: process.platform === "win32" }, async () => {
  const work = await mkdtemp(join(tmpdir(), "noodle-action-url-"));
  const binDir = join(work, "bin");
  const outDir = join(work, "out");
  const ghOutput = join(work, "github_output.txt");
  const argvOut = join(work, "npx-argv.json");
  await writeFile(ghOutput, "");

  // fake `npx`: record argv, emit a valid nanoodle --json result. CommonJS,
  // since the file is extensionless (no package.json "type" nearby).
  const fakeNpx = join(binDir, "npx");
  await mkdir(binDir, { recursive: true });
  await writeFile(fakeNpx, [
    "#!/usr/bin/env node",
    'const fs = require("fs");',
    "const argv = process.argv.slice(2);",
    'if (process.env.FAKE_NPX_ARGV_OUT) fs.writeFileSync(process.env.FAKE_NPX_ARGV_OUT, JSON.stringify(argv));',
    'process.stdout.write(JSON.stringify({ outputs: { Text: "ok from fake cli" }, costUsd: 0.001, costExact: true }));',
    "",
  ].join("\n"));
  await chmod(fakeNpx, 0o755);

  const shareUrl = "https://nanoodle.com/#a=H4sI_AbC-dEf&x=1&y=2"; // has # and & — must survive
  const child = spawn(process.execPath, [RUN_MJS], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`, // fake npx wins the PATH lookup
      FAKE_NPX_ARGV_OUT: argvOut,
      INPUT_GRAPH: shareUrl,
      INPUT_API_KEY: "test-key-123",
      INPUT_INPUTS: "",
      INPUT_SET: "",
      INPUT_OUT_DIR: outDir,
      INPUT_TIMEOUT_MS: "",
      GITHUB_OUTPUT: ghOutput,
      // INPUT_NANOODLE_VERSION deliberately unset — asserts the 0.2.0 default
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

  // the CLI received: --yes nanoodle@0.2.0 run <shareUrl> --out <outDir> --json
  const cliArgv = JSON.parse(await readFile(argvOut, "utf8"));
  assert.equal(cliArgv[1], "nanoodle@0.2.0", "default version is not 0.2.0: " + JSON.stringify(cliArgv));
  assert.equal(cliArgv[2], "run");
  assert.equal(cliArgv[3], shareUrl, "share URL was not passed through verbatim: " + JSON.stringify(cliArgv));
  assert.ok(cliArgv.includes("--json"));

  // the run succeeded and wrote outputs — the URL never tripped an exists/stat check
  const gh = await readFile(ghOutput, "utf8");
  assert.match(gh, /^cost-usd=0\.001$/m);
  assert.match(gh, new RegExp(`^out-dir=${outDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
});
