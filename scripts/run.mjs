#!/usr/bin/env node
/**
 * run-noodle-action worker — invoked by action.yml.
 *
 * Reads INPUT_* env vars (set explicitly in the composite step's env: block),
 * builds the argv for `npx --yes nanoodle@<version> run ...`, spawns it with
 * the API key in the child's NANOGPT_API_KEY env (never in argv, never
 * logged), captures the --json result to <out-dir>/nanoodle-result.json, and
 * writes out-dir / cost-usd / result-json to $GITHUB_OUTPUT.
 *
 * Pure helpers (parseLines, buildArgv) are exported for unit tests; the main
 * flow only runs when this file is the entrypoint.
 */
import { spawn } from "node:child_process";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

/**
 * True when `graph` is a nanoodle share link rather than a repo file path:
 * an http(s) URL, or a bare #g=/#j=/#a= (or #ga=) fragment. Mirrors the
 * `isShareRef` detection in nanoodle-js's share decoder — the CLI (>=0.2.0)
 * resolves these itself, so the action passes them through untouched.
 */
export function isShareRef(s) {
  return typeof s === "string" && (/^https?:\/\//i.test(s) || /^#?(ga|[gja])=/.test(s));
}

/**
 * Parse a multiline action input into ["KEY=VALUE", ...].
 * Blank lines and lines starting with '#' are skipped; other lines must
 * contain '=' with a non-empty key.
 */
export function parseLines(text, what = "input") {
  const out = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) throw new Error(`${what}: expected KEY=VALUE, got: ${line}`);
    out.push(line);
  }
  return out;
}

/** Build the npx argv (everything after the `npx` command itself). */
export function buildArgv({ graph, inputs = [], sets = [], outDir, timeoutMs, version }) {
  const argv = ["--yes", `nanoodle@${version}`, "run", graph];
  for (const kv of inputs) argv.push("--input", kv);
  for (const kv of sets) argv.push("--set", kv);
  argv.push("--out", outDir, "--json");
  if (timeoutMs) argv.push("--timeout", String(timeoutMs));
  return argv;
}

async function writeOutputs(pairs) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return; // running outside Actions (e.g. local debug) — nothing to write
  let text = "";
  for (const [k, v] of Object.entries(pairs)) {
    const val = String(v ?? "");
    if (val.includes("\n")) {
      const delim = `noodle_EOF_${Math.random().toString(36).slice(2)}`;
      text += `${k}<<${delim}\n${val}\n${delim}\n`;
    } else {
      text += `${k}=${val}\n`;
    }
  }
  await appendFile(file, text);
}

/** One attempt only: retries could repeat paid graph nodes. */
async function runCli(argv, apiKey, timeoutMs) {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(npx, argv, {
    env: { ...process.env, NANOGPT_API_KEY: apiKey },
    // Give npx and its CLI descendants a group so cancellation reaches both.
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "", stopped = null, forceTimer, timeoutTimer;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => { stdout += d; });
  const kill = (signal) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  };
  const stop = (reason) => {
    if (stopped) return;
    stopped = reason;
    console.error(reason === "timeout"
      ? `run-noodle-action: timed out after ${timeoutMs}ms`
      : `run-noodle-action: received ${reason}; stopping nanoodle`);
    kill(reason === "timeout" ? "SIGTERM" : reason);
    forceTimer = setTimeout(() => kill("SIGKILL"), 5000);
  };
  const onTerm = () => stop("SIGTERM");
  const onInt = () => stop("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  if (timeoutMs) timeoutTimer = setTimeout(() => stop("timeout"), Number(timeoutMs));
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    // A CLI may handle termination and exit 0. Cancellation still means failure.
    return { stdout, code, signal, stopped };
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(forceTimer);
    if (stopped) kill("SIGKILL"); // remove descendants even if npx exited first
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  }
}

async function main() {
  const graph = process.env.INPUT_GRAPH;
  const apiKey = process.env.INPUT_API_KEY;
  const outDir = process.env.INPUT_OUT_DIR || "nanoodle-out";
  const version = process.env.INPUT_NANOODLE_VERSION || "0.4.0";
  const timeoutMs = process.env.INPUT_TIMEOUT_MS || "";

  if (!graph) { console.error("run-noodle-action: 'graph' input is required"); process.exit(1); }
  if (!apiKey) { console.error("run-noodle-action: 'api-key' input is required (pass a secret; it is never logged)"); process.exit(1); }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("'nanoodle-version' must be an exact version such as 0.4.0");
  }
  if (timeoutMs && (!/^\d+$/.test(timeoutMs) || !Number.isSafeInteger(Number(timeoutMs)) ||
    Number(timeoutMs) < 1 || Number(timeoutMs) > 2147483647)) {
    throw new Error("'timeout-ms' must be an integer from 1 to 2147483647");
  }

  let inputs, sets;
  try {
    inputs = parseLines(process.env.INPUT_INPUTS, "inputs");
    sets = parseLines(process.env.INPUT_SET, "set");
  } catch (e) {
    console.error("run-noodle-action: " + e.message);
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const resultPath = join(outDir, "nanoodle-result.json");
  await rm(resultPath, { force: true }); // a failed attempt must not expose an older result
  if (isShareRef(graph)) console.error("run-noodle-action: loading graph from a share link");
  const argv = buildArgv({ graph, inputs, sets, outDir, timeoutMs, version });
  console.error("running: npx " + argv.join(" ")); // argv never contains the key

  const { stdout, code, signal, stopped } = await runCli(argv, apiKey, timeoutMs);
  let result = null;
  if (stdout.trim()) {
    try {
      const parsed = JSON.parse(stdout);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
        parsed.outputs && typeof parsed.outputs === "object" && !Array.isArray(parsed.outputs)) {
        result = parsed;
      }
    } catch { /* non-JSON output (early CLI failure) */ }
  }

  if (result) {
    await writeFile(resultPath, stdout);
    await writeOutputs({
      "out-dir": outDir,
      "cost-usd": result.costUsd ?? "",
      "result-json": resultPath,
    });
    if (!result.costExact && result.costUsd != null) {
      console.error(`note: cost-usd $${result.costUsd} is a floor (some calls did not report a price)`);
    }
  }

  if (stopped) {
    process.exitCode = stopped === "SIGTERM" ? 143 : stopped === "SIGINT" ? 130 : 1;
    return;
  }
  if (code !== 0) {
    console.error(`run-noodle-action: nanoodle exited with ${signal ? `signal ${signal}` : `code ${code}`}`);
    process.exitCode = code || 1;
    return;
  }
  if (!result) {
    console.error("run-noodle-action: no valid JSON run summary on stdout (expected an object with outputs)");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("run-noodle-action: " + (e && e.message || e)); process.exit(1); });
}
