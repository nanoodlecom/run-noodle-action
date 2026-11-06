import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("../scripts/run.mjs", import.meta.url));
const summary = { outputs: { Text: "ok" }, costUsd: 0.001, costExact: true };

// Shadow npx: these tests never resolve packages or contact a paid API.
async function fixture(t, script, inputs = {}) {
  const work = await mkdtemp(join(tmpdir(), "noodle-lifecycle-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const bin = join(work, "bin");
  const out = join(work, "out");
  const gh = join(work, "github-output");
  const calls = join(work, "calls");
  await mkdir(bin);
  await mkdir(out);
  await writeFile(join(out, "nanoodle-result.json"), JSON.stringify(summary));
  await writeFile(gh, "");
  await writeFile(join(bin, "npx"), `#!${process.execPath}\n` +
    `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(calls)}, 'call\\n');\n` + script);
  await chmod(join(bin, "npx"), 0o755);
  const child = spawn(process.execPath, [worker], {
    cwd: work,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      INPUT_GRAPH: "graph.json", INPUT_API_KEY: "fake-key",
      INPUT_INPUTS: "", INPUT_SET: "", INPUT_TIMEOUT_MS: "",
      INPUT_NANOODLE_VERSION: "0.4.0", INPUT_OUT_DIR: out,
      GITHUB_OUTPUT: gh, ...inputs,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
  // Avoid leaving a fixture running if an assertion fails.
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  return { work, out, gh, calls, child, done };
}

const posix = { skip: process.platform === "win32", timeout: 15000 };

for (const value of [true, 42, "hello", [], {}, { outputs: [] }]) {
  test(`rejects JSON that is not a run summary: ${JSON.stringify(value)}`, posix, async (t) => {
    const f = await fixture(t, `process.stdout.write(${JSON.stringify(JSON.stringify(value))});`);
    const result = await f.done;
    assert.equal(result.code, 1, result.stderr);
    assert.equal(await readFile(f.gh, "utf8"), "");
    await assert.rejects(readFile(join(f.out, "nanoodle-result.json")), { code: "ENOENT" });
  });
}

test("an empty failed run removes the previous result without retrying", posix, async (t) => {
  const f = await fixture(t, "setTimeout(() => process.exit(1), 200);");
  const path = join(f.out, "nanoodle-result.json");
  const result = await f.done;
  assert.equal(result.code, 1, result.stderr);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  assert.equal(await readFile(f.gh, "utf8"), "");
  assert.equal(await readFile(f.calls, "utf8"), "call\n");
});

test("a failed CLI run preserves current partial results and its exit code", posix, async (t) => {
  const partial = { ...summary, errors: [{ message: "failed node" }] };
  const f = await fixture(t, `process.stdout.write(${JSON.stringify(JSON.stringify(partial))}); process.exitCode = 7;`);
  const result = await f.done;
  assert.equal(result.code, 7, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(f.out, "nanoodle-result.json"), "utf8")), partial);
  assert.match(await readFile(f.gh, "utf8"), /^cost-usd=0\.001$/m);
  assert.equal(await readFile(f.calls, "utf8"), "call\n");
});

test("the action timeout also bounds CLI preparation before any JSON", posix, async (t) => {
  const f = await fixture(t, "setTimeout(() => process.exit(0), 2000);", { INPUT_TIMEOUT_MS: "150" });
  const result = await f.done;
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /timed out/);
  assert.equal(await readFile(f.gh, "utf8"), "");
  assert.equal(await readFile(f.calls, "utf8"), "call\n");
});

test("cancellation reaches npx and cannot turn into success", posix, async (t) => {
  const grandchild = `process.on('SIGTERM', () => {
    require('node:fs').writeFileSync('grandchild-cancelled', 'yes'); process.exit(0);
  }); process.stdout.write('ready'); setTimeout(() => process.exit(0), 3000);`;
  const f = await fixture(t, `process.on('SIGTERM', () => {
    fs.writeFileSync('cancelled', 'yes');
    process.stdout.write(${JSON.stringify(JSON.stringify(summary))});
    if (sub.exitCode !== null || sub.signalCode !== null) process.exit(0);
    else sub.once('close', () => process.exit(0));
  });
  const sub = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}]);
  sub.stdout.once('data', () => fs.writeFileSync('ready', 'yes'));
  setTimeout(() => process.exit(0), 3000);`);
  // Marker paths belong to the fixture, including the CLI's cwd.
  // Wait for a readiness message via an explicit marker rather than a timing guess.
  const ready = join(f.work, "ready");
  for (let n = 0; n < 100; n++) {
    try { await readFile(ready); break; } catch (e) { if (n === 99) throw e; }
    await new Promise((r) => setTimeout(r, 20));
  }
  f.child.kill("SIGTERM");
  const result = await f.done;
  assert.equal(result.code, 143, result.stderr);
  assert.equal(await readFile(join(f.work, "cancelled"), "utf8"), "yes");
  assert.equal(await readFile(join(f.work, "grandchild-cancelled"), "utf8"), "yes");
  assert.equal(await readFile(f.calls, "utf8"), "call\n");
});

test("SIGINT is forwarded and retains a cancellation exit status", posix, async (t) => {
  const f = await fixture(t, `process.on('SIGINT', () => process.exit(0));
    fs.writeFileSync('ready', 'yes'); setTimeout(() => process.exit(0), 3000);`);
  for (let n = 0; n < 100; n++) {
    try { await readFile(join(f.work, "ready")); break; } catch (e) { if (n === 99) throw e; }
    await new Promise((r) => setTimeout(r, 20));
  }
  f.child.kill("SIGINT");
  const result = await f.done;
  assert.equal(result.code, 130, result.stderr);
  assert.equal(await readFile(f.calls, "utf8"), "call\n");
});

test("a CLI terminated by a signal fails even after printing a result", posix, async (t) => {
  const f = await fixture(t, `process.stdout.write(${JSON.stringify(JSON.stringify(summary))});
    process.kill(process.pid, 'SIGTERM');`);
  const result = await f.done;
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /signal SIGTERM/);
});

test("a split UTF-8 character survives stdout collection", posix, async (t) => {
  const result = { ...summary, outputs: { Text: "🍜" } };
  const f = await fixture(t, `const data = Buffer.from(${JSON.stringify(JSON.stringify(result))});
    const split = data.indexOf(Buffer.from('🍜')) + 1;
    process.stdout.write(data.subarray(0, split));
    setTimeout(() => process.stdout.write(data.subarray(split)), 50);`);
  assert.equal((await f.done).code, 0);
  assert.deepEqual(JSON.parse(await readFile(join(f.out, "nanoodle-result.json"), "utf8")), result);
});

test("a missing npx fails without retaining the old result", posix, async (t) => {
  const f = await fixture(t, "", { PATH: "/nonexistent-noodle-bin" });
  const result = await f.done;
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /ENOENT/);
  await assert.rejects(readFile(join(f.out, "nanoodle-result.json")), { code: "ENOENT" });
  await assert.rejects(readFile(f.calls), { code: "ENOENT" });
});

for (const inputs of [
  ...["0", "-1", "NaN", "Infinity", "1.5", "2147483648"].map((value) => ({ INPUT_TIMEOUT_MS: value })),
  ...["latest", "^0.4.0", "0.4"].map((value) => ({ INPUT_NANOODLE_VERSION: value })),
]) {
  test(`invalid options fail before launching npx: ${JSON.stringify(inputs)}`, posix, async (t) => {
    const f = await fixture(t, "process.exit(0);", inputs);
    assert.equal((await f.done).code, 1);
    await assert.rejects(readFile(f.calls), { code: "ENOENT" });
  });
}

test("timeout forcibly stops a CLI that ignores SIGTERM", posix, async (t) => {
  const f = await fixture(t, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`,
    { INPUT_TIMEOUT_MS: "300" });
  const started = Date.now();
  const result = await f.done;
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /timed out/);
  assert.ok(Date.now() - started < 10000, "forced shutdown took too long");
  assert.equal(await readFile(f.calls, "utf8"), "call\n");
});
