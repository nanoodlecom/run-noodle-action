import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyRelease, planRelease, pushRef, readRefs } from "../scripts/release.mjs";

const base = "a".repeat(40);
const source = "b".repeat(40);
const main = "refs/heads/main";
const alias = "refs/tags/v1";
const prior = "refs/tags/v1.0.1";
const candidate = "refs/tags/v1.0.2";
const published = (tag) => ({ tag_name: tag, published_at: "2026-11-06T08:00:00Z", draft: false, prerelease: false });

function releaseState() {
  return {
    version: "1.0.2", source,
    refs: new Map([[main, source], [alias, base], [prior, base]]),
    releases: [published("v1.0.1")],
    isAncestor: () => true,
    sameRuntime: () => true,
  };
}

test("the existing version permits docs and CI changes and rejects runtime changes", () => {
  const state = { ...releaseState(), version: "1.0.1" };
  assert.equal(planRelease(state).status, "unchanged");
  assert.throws(() => planRelease({ ...state, sameRuntime: () => false }), /Bump ACTION_VERSION/);
});

test("a newer qualified version creates a tag and an exact partial retry reuses it", () => {
  const state = releaseState();
  assert.deepEqual(planRelease(state), {
    status: "publish", tag: "v1.0.2", target: source, aliasRefObject: base, createTag: true,
  });
  state.refs.set(candidate, source);
  assert.equal(planRelease(state).createTag, false);
  state.refs.set(candidate, base);
  assert.throws(() => planRelease(state), /belongs to a different commit/);
});

test("a retry promotes a published version even when the alias is annotated", () => {
  const annotatedTag = "c".repeat(40);
  const state = releaseState();
  state.refs.set(alias, annotatedTag);
  state.refs.set(`${alias}^{}`, base);
  state.refs.set(candidate, source);
  state.releases.push(published("v1.0.2"));
  assert.deepEqual(planRelease(state), {
    status: "promote", tag: "v1.0.2", target: source, aliasRefObject: annotatedTag,
  });
});

test("the plan rejects downgrades and unpublished or divergent alias targets", () => {
  const state = releaseState();
  state.refs.set("refs/tags/v1.1.0", source);
  assert.throws(() => planRelease(state), /older than a version tag/);
  state.refs.delete("refs/tags/v1.1.0");
  assert.throws(() => planRelease({ ...state, isAncestor: () => false }), /tested commit history/);
  state.refs.set(alias, source);
  assert.throws(() => planRelease(state), /must point to a published release/);
});

test("publication advances v1 from the creation receipt even when the release list lags", () => {
  const state = releaseState();
  const plan = planRelease(state);
  const operations = [];
  const result = applyRelease(plan, source, {
    remote: "origin",
    refs: () => new Map(state.refs),
    releases: () => assert.fail("Do not re-read the release list after creation"),
    git: (...args) => {
      operations.push(args);
      const [target, ref] = args[3].split(":");
      state.refs.set(ref, target);
    },
    gh: (...args) => {
      operations.push(args);
      assert.equal(state.refs.get(candidate), source);
      assert.equal(state.refs.get(alias), base);
      return JSON.stringify(published("v1.0.2"));
    },
  });
  assert.equal(result, "promoted");
  assert.deepEqual(operations[0], ["push", `--force-with-lease=${candidate}:`, "origin", `${source}:${candidate}`]);
  assert.deepEqual(operations[1], [
    "api", "repos/nanoodlecom/run-noodle-action/releases", "--method", "POST",
    "--raw-field", "tag_name=v1.0.2", "--raw-field", `target_commitish=${source}`,
    "--raw-field", "name=v1.0.2", "--field", "generate_release_notes=true",
  ]);
  assert.deepEqual(operations[2], ["push", `--force-with-lease=${alias}:${base}`, "origin", `${source}:${alias}`]);
});

test("a main advance during release creation keeps the earlier action live at v1", () => {
  const state = releaseState();
  state.refs.set(candidate, source);
  const plan = planRelease(state);
  const result = applyRelease(plan, source, {
    remote: "origin",
    refs: () => new Map(state.refs),
    releases: () => state.releases,
    git: () => assert.fail("Do not update v1 after main advances"),
    gh: () => {
      state.refs.set(main, "c".repeat(40));
      return JSON.stringify(published("v1.0.2"));
    },
  });
  assert.equal(result, "superseded");
  assert.equal(state.refs.get(alias), base);
});

test("a draft creation receipt stops before promoting v1", () => {
  const state = releaseState();
  state.refs.set(candidate, source);
  assert.throws(() => applyRelease(planRelease(state), source, {
    remote: "origin",
    refs: () => new Map(state.refs),
    releases: () => assert.fail("Do not re-read the release list after creation"),
    git: () => assert.fail("Do not promote a draft release"),
    gh: () => JSON.stringify({ ...published("v1.0.2"), draft: true }),
  }), /Expected a published GitHub Release/);
});

test("Git rejects an alias update with a stale expected ref", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "run-noodle-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, "remote.git");
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
  git("init", "--quiet", "--bare", remote);
  git("init", "--quiet", "--initial-branch=main");
  git("config", "core.hooksPath", "/dev/null");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release-test@example.invalid");
  git("-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "prior");
  const previous = git("rev-parse", "HEAD").trim();
  git("-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "candidate");
  const next = git("rev-parse", "HEAD").trim();

  pushRef(git, remote, previous, alias, "");
  pushRef(git, remote, next, alias, previous);
  assert.throws(() => pushRef(git, remote, previous, alias, previous), /stale info/);
  assert.equal(readRefs(git("ls-remote", remote, alias)).get(alias), next);
});
