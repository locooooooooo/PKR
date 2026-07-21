#!/usr/bin/env node

import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { assert, publicTree, root } from "./release-utils.mjs";

const args = process.argv.slice(2);
const target = option("--target") ?? args[0];
const expectedHead = option("--expected-head") ?? args[1];

assert(target, "public candidate target is required");
assert(expectedHead && /^[0-9a-f]{40}$/.test(expectedHead), "public candidate base must be a full Git SHA");

const resolvedTarget = resolve(target);
assert(resolvedTarget !== root, "public candidate target must not be the development checkout");
assert(existsSync(resolvedTarget), "public candidate target does not exist");

const targetRoot = resolve(runGit(["rev-parse", "--show-toplevel"], resolvedTarget).trim());
assert(realpathSync(targetRoot) === realpathSync(resolvedTarget), "--target must be the root of its Git checkout");
assert(runGit(["status", "--porcelain"], resolvedTarget).trim() === "", "public candidate target must be clean");
assert(runGit(["rev-parse", "HEAD"], resolvedTarget).trim() === expectedHead, "public candidate target HEAD drifted");

const remoteUrl = runGit(["remote", "get-url", "origin"], resolvedTarget).trim();
assert(isPublicRemote(remoteUrl), `target origin is not the public PKR repository: ${remoteUrl}`);

const { publicFiles, privateFiles, unknownFiles } = publicTree();
assert(unknownFiles.length === 0, `source tree has unclassified paths: ${unknownFiles.join(", ")}`);
const publicSet = new Set(publicFiles);
const tracked = runGit(["ls-files", "-z"], resolvedTarget).split("\0").filter(Boolean);
const removed = [];

for (const path of tracked) {
  if (publicSet.has(normalize(path))) continue;
  const absolute = checkedTargetPath(path);
  if (existsSync(absolute) || lstatExists(absolute)) {
    rmSync(absolute, { force: true });
  }
  removed.push(normalize(path));
}

for (const path of publicFiles) {
  const source = resolve(root, path);
  const destination = checkedTargetPath(path);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { force: true, errorOnExist: false });
}

const status = runGit(["status", "--porcelain=v1"], resolvedTarget)
  .split(/\r?\n/)
  .filter(Boolean);
assert(status.length > 0, "public candidate projection produced no changes");

process.stdout.write(`${JSON.stringify({
  ok: true,
  sourceCommit: runGit(["rev-parse", "HEAD"], root).trim(),
  sourceDirty: runGit(["status", "--porcelain"], root).trim().length > 0,
  publicBaseCommit: expectedHead,
  publicRemote: "https://github.com/locooooooooo/PKR.git",
  copiedPublicFiles: publicFiles.length,
  excludedPrivateFiles: privateFiles.length,
  removedObsoleteTrackedFiles: removed.length,
  candidateStatusEntries: status.length,
  pushAttempted: false,
}, null, 2)}\n`);

function option(name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function runGit(gitArgs, cwd) {
  const result = spawnSync("git", gitArgs, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${gitArgs.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function normalize(path) {
  return path.replaceAll("\\", "/");
}

function checkedTargetPath(path) {
  const normalized = normalize(path);
  assert(normalized.length > 0 && !isAbsolute(normalized), `invalid candidate path: ${path}`);
  const absolute = resolve(resolvedTarget, normalized);
  const fromTarget = relative(resolvedTarget, absolute);
  assert(fromTarget !== "" && !fromTarget.startsWith("..") && !isAbsolute(fromTarget), `candidate path escapes target: ${path}`);
  return absolute;
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isPublicRemote(url) {
  const normalized = url.trim().replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/");
  return normalized.toLowerCase() === "https://github.com/locooooooooo/pkr";
}
