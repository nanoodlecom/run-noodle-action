import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const repository = "nanoodlecom/run-noodle-action";
const origin = `https://github.com/${repository}.git`;
const mainRef = "refs/heads/main";
const majorRef = "refs/tags/v1";
const runtimePaths = ["action.yml", "scripts/", ":(exclude)scripts/release.mjs"];

function versionParts(tag) {
  const match = /^v1\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(tag);
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  if (parts.every(Number.isSafeInteger)) return parts;
}

export function readRefs(output) {
  return new Map(output.trim().split("\n").filter(Boolean).map((line) => {
    const [oid, ref] = line.split("\t");
    return [ref, oid];
  }));
}

function commitAt(refs, ref) {
  return refs.get(`${ref}^{}`) ?? refs.get(ref);
}

function isPublished(record) {
  return Boolean(record?.published_at && !record.draft && !record.prerelease);
}

export function planRelease({ version, source, refs, releases, isAncestor, sameRuntime }) {
  const tag = `v${version}`;
  const parts = versionParts(tag);
  if (!parts) throw new Error("ACTION_VERSION must be a stable 1.x.y version");

  const tagRef = `refs/tags/${tag}`;
  const tagged = commitAt(refs, tagRef);
  const alias = commitAt(refs, majorRef);
  const aliasRefObject = refs.get(majorRef) ?? "";
  const record = releases.find((item) => item.tag_name === tag);
  const newerTag = [...refs.keys()].some((ref) => {
    const other = versionParts(ref.replace(/^refs\/tags\//, ""));
    return other && (other[0] > parts[0] || (other[0] === parts[0] && other[1] > parts[1]));
  });
  if (newerTag) throw new Error(`${tag} is older than a version tag already present`);
  if (record && (!isPublished(record) || !tagged)) {
    throw new Error(`Review the incomplete release for ${tag} before publishing`);
  }
  if (alias) {
    const known = releases.some((item) => isPublished(item) && versionParts(item.tag_name)
      && commitAt(refs, `refs/tags/${item.tag_name}`) === alias);
    if (!known || !isAncestor(alias, source)) {
      throw new Error("Current v1 must point to a published release in the tested commit history");
    }
  }
  if (isPublished(record)) {
    if (!isAncestor(tagged, source) || !sameRuntime(tagged, source)) {
      throw new Error(`Bump ACTION_VERSION when the action runtime changes from ${tag}`);
    }
    return { status: alias === tagged ? "unchanged" : "promote", tag, target: tagged, aliasRefObject };
  }
  if (tagged && tagged !== source) {
    throw new Error(`Existing tag ${tag} belongs to a different commit`);
  }
  return { status: "publish", tag, target: source, aliasRefObject, createTag: !tagged };
}

function run(command, ...args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function gitTest(...args) {
  const result = spawnSync("git", args, { stdio: ["ignore", "ignore", "inherit"] });
  if (result.status === 0 || result.status === 1) return result.status === 0;
  throw result.error ?? new Error(`git ${args[0]} failed with status ${result.status}`);
}

function remoteRefs() {
  return readRefs(run("git", "ls-remote", origin, mainRef, "refs/tags/v1*"));
}

function releaseRecords() {
  const response = run("gh", "api", "--paginate", `repos/${repository}/releases?per_page=100`,
    "--jq", "[.[] | {tag_name,draft,prerelease,published_at}]");
  return response.trim().split("\n").flatMap((page) => JSON.parse(page));
}

export function pushRef(git, remote, target, ref, expected) {
  return git("push", `--force-with-lease=${ref}:${expected}`, remote, `${target}:${ref}`);
}

export function applyRelease(plan, source, { git, gh, refs, releases, remote }) {
  if (plan.status === "unchanged") return "unchanged";
  if (refs().get(mainRef) !== source) return "superseded";

  const versionRef = `refs/tags/${plan.tag}`;
  if (plan.status === "publish") {
    if (plan.createTag) pushRef(git, remote, plan.target, versionRef, "");
    if (commitAt(refs(), versionRef) !== plan.target) {
      throw new Error(`Version tag ${plan.tag} did not resolve to the tested commit`);
    }
    gh("release", "create", plan.tag, "--repo", repository, "--verify-tag",
      "--title", plan.tag, "--generate-notes");
  }

  if (!releases().some((record) => record.tag_name === plan.tag && isPublished(record))) {
    throw new Error(`Expected a published GitHub Release for ${plan.tag}`);
  }
  const observed = refs();
  if (commitAt(observed, versionRef) !== plan.target) throw new Error(`Version tag ${plan.tag} moved`);
  if (observed.get(mainRef) !== source) return "superseded";
  pushRef(git, remote, plan.target, majorRef, plan.aliasRefObject);
  const after = refs();
  if (commitAt(after, majorRef) !== plan.target || commitAt(after, versionRef) !== plan.target) {
    throw new Error(`GitHub v1 and ${plan.tag} did not resolve to the same tested commit`);
  }
  return "promoted";
}

function main(mode) {
  if (!["plan", "publish"].includes(mode)) throw new Error("Use release.mjs plan or publish");
  const source = run("git", "rev-parse", "HEAD").trim();
  if (mode === "publish" && (process.env.GITHUB_REPOSITORY !== repository
    || process.env.GITHUB_REF !== mainRef || process.env.GITHUB_EVENT_NAME !== "push"
    || process.env.GITHUB_SHA !== source)) {
    throw new Error(`Publishing requires the tested ${repository} main push`);
  }
  const refs = remoteRefs();
  if (mode === "publish" && refs.get(mainRef) !== source) {
    console.log(`Superseded main revision ${source}`);
    return;
  }
  const plan = planRelease({
    version: readFileSync("ACTION_VERSION", "utf8").trim(),
    source, refs, releases: releaseRecords(),
    isAncestor: (previous, next) => gitTest("merge-base", "--is-ancestor", previous, next),
    sameRuntime: (previous, next) => gitTest("diff", "--quiet", previous, next, "--", ...runtimePaths),
  });
  if (mode === "plan") {
    console.log(plan.status);
    return;
  }
  run("gh", "auth", "setup-git", "--hostname", "github.com");
  const result = applyRelease(plan, source, {
    git: (...args) => run("git", ...args),
    gh: (...args) => run("gh", ...args),
    refs: remoteRefs, releases: releaseRecords, remote: origin,
  });
  console.log(`${result} ${plan.tag} at ${plan.target}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]);
}
