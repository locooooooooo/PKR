#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const diff = git(["diff", "--check"]);
if (diff.status !== 0) {
  fail("git diff --check failed", diff);
}

const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
if (status.status !== 0) {
  fail("git status failed", status);
}
if (status.stdout.length > 0) {
  process.stderr.write("Candidate worktree is not clean:\n");
  process.stderr.write(status.stdout);
  process.exit(1);
}

process.stdout.write("PASS: candidate worktree is clean.\n");

function git(args) {
  return spawnSync("git", args, { encoding: "utf8" });
}

function fail(message, result) {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  process.stderr.write(`${message}${output ? `\n${output}` : ""}\n`);
  process.exit(1);
}
