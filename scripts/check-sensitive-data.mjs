#!/usr/bin/env node

import { gunzipSync } from "node:zlib";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { publicTree as releasePublicTree } from "./release-utils.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 10_000;
const TEXT_EXTENSIONS = new Set([
  "", ".cjs", ".css", ".d.ts", ".html", ".js", ".json", ".jsonl", ".jsx", ".md", ".mjs",
  ".log", ".ps1", ".py", ".sh", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
const RULES = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["authorization-bearer", /authorization\s*:\s*bearer\s+[^\s"']+/gi],
  ["credential-assignment", /["']?(?:api[_-]?key|credential|password|private[_-]?key|secret|token)["']?\s*[:=]\s*["']?[A-Za-z0-9_+/.=-]{8,}/gi],
  ["aws-access-key", /\bAKIA[A-Z0-9]{16}\b/g],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ["windows-user-path", /[A-Za-z]:\\Users\\[^\s"']+/gi],
  ["posix-user-path", /\/(?:home|Users)\/[^\s"']+/g],
];

function displayPath(path, prefix = "tree") {
  const local = relative(root, path).replaceAll("\\", "/");
  return local && !local.startsWith("../") ? local : `${prefix}:${basename(path)}`;
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

function scanText(text, path, findings) {
  for (const [rule, pattern] of RULES) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push({ path, line: lineNumber(text, match.index ?? 0), rule });
    }
  }
}

function scanBuffer(buffer, path, findings, counters) {
  counters.files += 1;
  counters.bytes += buffer.byteLength;
  if (buffer.byteLength > MAX_FILE_BYTES) {
    findings.push({ path, line: 0, rule: "file-size-limit" });
    return;
  }
  if (buffer.includes(0)) return;
  scanText(buffer.toString("utf8"), path, findings);
}

async function collectPath(path, output) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`refusing to scan symbolic link ${displayPath(path)}`);
  }
  if (metadata.isDirectory()) {
    for (const entry of await readdir(path)) {
      if ([".git", ".pkr", "node_modules", "dist", "coverage"].includes(entry)) continue;
      await collectPath(join(path, entry), output);
    }
    return;
  }
  if (metadata.isFile() && TEXT_EXTENSIONS.has(extname(path).toLowerCase())) output.push(path);
}

function tarEntries(path, compressed) {
  const archive = gunzipSync(compressed, { maxOutputLength: MAX_ARCHIVE_BYTES + 1 });
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error("archive exceeds 32 MiB expansion limit");
  const entries = [];
  let offset = 0;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > archive.byteLength) {
      throw new Error(`invalid tar entry in ${basename(path)}`);
    }
    if ((type === "0" || type === "\0") && entries.length < MAX_ARCHIVE_FILES) {
      entries.push({ name: prefix ? `${prefix}/${name}` : name, body: archive.subarray(offset + 512, offset + 512 + size) });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (entries.length >= MAX_ARCHIVE_FILES) throw new Error("archive exceeds file-count limit");
  return entries;
}

async function main() {
  const args = process.argv.slice(2);
  const paths = [];
  const tarballs = [];
  let output;
  let publicTree = args.length === 0;
  let npmPack = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--public-tree") publicTree = true;
    else if (argument === "--npm-pack") npmPack = true;
    else if (argument === "--path") paths.push(resolve(args[++index]));
    else if (argument === "--tarball") tarballs.push(resolve(args[++index]));
    else if (argument === "--output") output = resolve(args[++index]);
    else throw new Error(`unknown option ${argument}`);
  }
  if (publicTree) {
    const { publicFiles } = releasePublicTree();
    paths.push(...publicFiles.map((path) => resolve(root, path)));
  }
  let packRoot;
  if (npmPack) {
    packRoot = await mkdtemp(join(tmpdir(), "pkr-sensitive-pack-"));
    const packArgs = ["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot];
    const packed = spawnSync(
      process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm",
      process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd", ...packArgs] : packArgs,
      { cwd: root, encoding: "utf8" },
    );
    if (packed.status !== 0) {
      throw new Error(packed.stderr || packed.error?.message || "npm pack failed");
    }
    const result = JSON.parse(packed.stdout);
    if (!Array.isArray(result) || typeof result[0]?.filename !== "string") {
      throw new Error("npm pack did not return one tarball filename");
    }
    tarballs.push(join(packRoot, result[0].filename));
  }
  try {
    const files = [];
    for (const path of [...new Set(paths)]) await collectPath(path, files);
    const findings = [];
    const counters = { files: 0, bytes: 0 };
    for (const path of [...new Set(files)]) {
      scanBuffer(await readFile(path), displayPath(path), findings, counters);
    }
    for (const tarball of tarballs) {
      for (const entry of tarEntries(tarball, await readFile(tarball))) {
        scanBuffer(entry.body, `tar:${basename(tarball)}!/${entry.name}`, findings, counters);
      }
    }
    const report = {
      version: "pkr.sensitive-data-scan/v1",
      generatedAt: new Date().toISOString(),
      scope: { publicTree, explicitPaths: paths.length, npmPack, tarballs: tarballs.map((path) => basename(path)) },
      limits: { maxFileBytes: MAX_FILE_BYTES, maxArchiveBytes: MAX_ARCHIVE_BYTES, maxArchiveFiles: MAX_ARCHIVE_FILES },
      scannedFiles: counters.files,
      scannedBytes: counters.bytes,
      findings,
      passed: findings.length === 0,
    };
    const encoded = `${JSON.stringify(report, null, 2)}\n`;
    if (output) await writeFile(output, encoded, "utf8");
    process.stdout.write(encoded);
    return report.passed ? 0 : 1;
  } finally {
    if (packRoot) await rm(packRoot, { recursive: true, force: true });
  }
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
