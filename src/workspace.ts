import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { PkrError } from "./errors.js";
import { runBoundedProcess } from "./process.js";
import { digest } from "./util.js";

export interface RepositoryEvidence {
  adapter: "pkr.git-workspace/v1";
  repositoryRoot: string;
  head: string;
  status: string;
  diff: string;
  stagedDiff: string;
  changedFiles: string[];
  clean: boolean;
  contentDigest: string;
  collectedAt: string;
}

const REPOSITORY_PATHSPEC = ["--", ".", ":(exclude).pkr/**"];

function parseChangedFiles(porcelain: string): string[] {
  const entries = porcelain.split("\0");
  const files: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    const status = entry.slice(0, 2);
    const path = entry.slice(3).replaceAll("\\", "/");
    if (path && path !== ".pkr" && !path.startsWith(".pkr/")) {
      files.push(path);
    }
    if (status.includes("R") || status.includes("C")) {
      const source = entries[index + 1]?.replaceAll("\\", "/");
      if (source && source !== ".pkr" && !source.startsWith(".pkr/")) {
        files.push(source);
      }
      index += 1;
    }
  }
  return [...new Set(files)].sort();
}

async function git(
  root: string,
  args: string[],
  maxOutputBytes = 512 * 1024,
): Promise<string> {
  const result = await runBoundedProcess({
    executable: "git",
    args,
    cwd: root,
    timeoutMs: 30_000,
    maxOutputBytes,
  });
  if (result.failureReason) {
    throw new PkrError(
      "PKR-WORKSPACE-001",
      `git ${args.join(" ")} failed: ${result.failureReason}; ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

export async function collectRepositoryEvidence(
  projectRoot: string,
): Promise<RepositoryEvidence> {
  const root = resolve(projectRoot);
  const gitRoot = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
  const [canonicalRoot, canonicalGitRoot] = await Promise.all([
    realpath(root),
    gitRoot ? realpath(gitRoot) : Promise.resolve(""),
  ]);
  const samePath = process.platform === "win32"
    ? canonicalRoot.toLowerCase() === canonicalGitRoot.toLowerCase()
    : canonicalRoot === canonicalGitRoot;
  if (!gitRoot || !samePath) {
    throw new PkrError(
      "PKR-WORKSPACE-001",
      "PKR project root must resolve to the exact Git repository root",
    );
  }
  const head = (await git(root, ["rev-parse", "--verify", "HEAD"])).trim();
  const status = await git(root, [
    "status",
    "--short",
    "--untracked-files=all",
    ...REPOSITORY_PATHSPEC,
  ]);
  const porcelain = await git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    ...REPOSITORY_PATHSPEC,
  ]);
  const diff = await git(root, ["diff", "--no-ext-diff", "--no-color", ...REPOSITORY_PATHSPEC]);
  const stagedDiff = await git(root, [
    "diff",
    "--cached",
    "--no-ext-diff",
    "--no-color",
    ...REPOSITORY_PATHSPEC,
  ]);
  const changedFiles = parseChangedFiles(porcelain);
  const content = { head, status, diff, stagedDiff, changedFiles };
  return {
    adapter: "pkr.git-workspace/v1",
    repositoryRoot: canonicalRoot,
    ...content,
    clean: changedFiles.length === 0,
    contentDigest: digest(content),
    collectedAt: new Date().toISOString(),
  };
}
