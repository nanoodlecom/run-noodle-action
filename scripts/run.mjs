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
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

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

async function main() {
  const graph = process.env.INPUT_GRAPH;
  const apiKey = process.env.INPUT_API_KEY;
  const outDir = process.env.INPUT_OUT_DIR || "nanoodle-out";
  const version = process.env.INPUT_NANOODLE_VERSION || "0.1.1";
  const timeoutMs = process.env.INPUT_TIMEOUT_MS || "";

  if (!graph) { console.error("run-noodle-action: 'graph' input is required"); process.exit(1); }
  if (!apiKey) { console.error("run-noodle-action: 'api-key' input is required (pass a secret; it is never logged)"); process.exit(1); }

  let inputs, sets;
  try {
    inputs = parseLines(process.env.INPUT_INPUTS, "inputs");
    sets = parseLines(process.env.INPUT_SET, "set");
  } catch (e) {
    console.error("run-noodle-action: " + e.message);
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const argv = buildArgv({ graph, inputs, sets, outDir, timeoutMs, version });
  console.error("running: npx " + argv.join(" ")); // argv never contains the key

  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(npx, argv, {
    env: { ...process.env, NANOGPT_API_KEY: apiKey },
    stdio: ["ignore", "pipe", "inherit"], // stdout = --json result; stderr (progress/errors) streams through
  });
  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d; });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  const resultPath = join(outDir, "nanoodle-result.json");
  let result = null;
  if (stdout.trim()) {
    await writeFile(resultPath, stdout);
    try { result = JSON.parse(stdout); } catch { /* non-JSON output (early CLI failure) */ }
  }

  if (result) {
    await writeOutputs({
      "out-dir": outDir,
      "cost-usd": result.costUsd ?? "",
      "result-json": resultPath,
    });
    if (!result.costExact && result.costUsd != null) {
      console.error(`note: cost-usd $${result.costUsd} is a floor (some calls did not report a price)`);
    }
  }

  if (code !== 0) {
    console.error(`run-noodle-action: nanoodle exited with code ${code}`);
    process.exit(code || 1);
  }
  if (!result) {
    console.error("run-noodle-action: no JSON result on stdout");
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("run-noodle-action: " + (e && e.message || e)); process.exit(1); });
}
