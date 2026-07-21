import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function resolveSafeRepositoryPath(root: string, candidate: string): string {
  if (!candidate || candidate.includes("\0") || isAbsolute(candidate)) {
    throw new Error("repository path must be a non-empty relative path");
  }
  const segments = candidate.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("repository path contains an unsafe segment");
  }
  const canonicalRoot = realpathSync(root);
  const target = resolve(canonicalRoot, ...segments);
  const fromRoot = relative(canonicalRoot, target);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("repository path escapes the repository root");
  }
  let cursor = canonicalRoot;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    if (!existsSync(cursor)) continue;
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink()) {
      throw new Error("repository path traverses a symbolic link or junction");
    }
    const canonical = realpathSync(cursor);
    const canonicalRelative = relative(canonicalRoot, canonical);
    if (
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(canonicalRelative)
    ) {
      throw new Error("repository path resolves outside the repository root");
    }
  }
  return target;
}
