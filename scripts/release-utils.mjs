import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function normalizePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
}

export function candidateFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  );
  return [...new Set(output.split("\0").filter(Boolean).map(normalizePath))].sort();
}

export function isPublicPath(path, manifest) {
  const normalized = normalizePath(path);
  if (manifest.privatePrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return false;
  }
  return manifest.rootFiles.includes(normalized) ||
    manifest.publicPrefixes.some((prefix) => normalized.startsWith(prefix));
}

export function isPrivatePath(path, manifest) {
  const normalized = normalizePath(path);
  return manifest.privatePrefixes.some((prefix) => normalized.startsWith(prefix));
}

export function publicTree() {
  const manifest = readJson("scripts/public-tree.json");
  const files = candidateFiles();
  const publicFiles = files.filter((path) => isPublicPath(path, manifest));
  const privateFiles = files.filter((path) => isPrivatePath(path, manifest));
  const unknownFiles = files.filter(
    (path) => !isPublicPath(path, manifest) && !isPrivatePath(path, manifest),
  );
  return { manifest, files, publicFiles, privateFiles, unknownFiles };
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})${output ? `\n${output}` : ""}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

export function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return run(process.execPath, [npmCli, ...args], options);
  }
  return run("npm", args, options);
}

export function sortedUnique(values) {
  return [...new Set(values)].sort();
}

export function compareExact(label, actual, expected) {
  const left = sortedUnique(actual);
  const right = sortedUnique(expected);
  const missing = right.filter((value) => !left.includes(value));
  const unlisted = left.filter((value) => !right.includes(value));
  assert(
    missing.length === 0 && unlisted.length === 0,
    `${label} drifted; missing=${JSON.stringify(missing)} unlisted=${JSON.stringify(unlisted)}`,
  );
}

export function sensitiveFindings(paths) {
  const forbiddenNames = [
    /(?:^|\/)\.env(?:\.|$)/i,
    /\.(?:pem|p12|pfx|key|sqlite|sqlite-shm|sqlite-wal)$/i,
  ];
  const patterns = [
    ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["GitHub token", /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/],
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
    ["API secret", /\bsk-[A-Za-z0-9]{20,}\b/],
    ["Windows user path", /\b[A-Za-z]:[\\/]Users[\\/](?![<{])[A-Za-z0-9._-]+[\\/]/],
    ["Unix home path", /\/(?:home|Users)\/(?![<{])[A-Za-z0-9._-]+\//],
    ["private development repository", new RegExp("PKR" + "Project", "i")],
    ["private development path", new RegExp("E:" + "\\\\PKR", "i")],
  ];
  const findings = [];
  for (const path of paths) {
    if (forbiddenNames.some((pattern) => pattern.test(path))) {
      findings.push(`${path}: forbidden sensitive filename`);
      continue;
    }
    const content = readFileSync(resolve(root, path));
    if (content.includes(0)) {
      continue;
    }
    const text = content.toString("utf8");
    for (const [label, pattern] of patterns) {
      if (pattern.test(text)) {
        findings.push(`${path}: ${label}`);
      }
    }
  }
  return findings;
}
