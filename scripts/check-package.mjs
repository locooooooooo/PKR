import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { assert, publicTree, readJson, root, runNpm, sensitiveFindings } from "./release-utils.mjs";

const packageJson = readJson("package.json");
const dryRun = runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"]);
const reports = JSON.parse(dryRun.stdout);
assert(Array.isArray(reports) && reports.length === 1, "npm pack returned an unexpected report");
const report = reports[0];
const paths = report.files.map((file) => file.path.replaceAll("\\", "/"));

const required = [
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "VERSION",
  "docs/architecture.md",
  "docs/quickstart.md",
  "docs/release/v1-contract-manifest.json",
  "docs/release/v1-stable-contract.md",
  "dist/cli.js",
  "dist/index.d.ts",
  "dist/index.js",
  "package.json",
];
for (const path of required) {
  assert(paths.includes(path), `packed artifact is missing ${path}`);
}

const forbidden = ["src/", "iterations/", ".pkr/", "release/", "node_modules/", ".env"];
const publicPaths = new Set(publicTree().publicFiles);
for (const path of paths) {
  assert(!forbidden.some((prefix) => path === prefix || path.startsWith(prefix)), `packed artifact contains ${path}`);
  assert(
    path.startsWith("dist/") || publicPaths.has(path),
    `packed artifact path is outside the public projection: ${path}`,
  );
}

assert(report.id === `${packageJson.name}@${packageJson.version}`, "npm pack identity disagrees with package.json");
assert(readFileSync(resolve(root, "LICENSE"), "utf8").includes("Apache License"), "LICENSE is not Apache-2.0 text");
assert(readFileSync(resolve(root, "NOTICE"), "utf8").includes("PKR"), "NOTICE does not identify PKR");

const packageFindings = sensitiveFindings(paths);
assert(packageFindings.length === 0, `packed-artifact sensitive-data scan failed:\n${packageFindings.join("\n")}`);

const notices = readFileSync(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8");
const lock = readJson("package-lock.json");
let dependenciesAudited = 0;
for (const path of Object.keys(lock.packages).filter((path) => path.startsWith("node_modules/"))) {
  const dependency = JSON.parse(readFileSync(resolve(root, path, "package.json"), "utf8"));
  const row = `| \`${dependency.name}\` | ${dependency.version} | ${dependency.license}`;
  assert(notices.includes(row), `THIRD_PARTY_NOTICES.md is missing ${dependency.name}@${dependency.version}`);
  dependenciesAudited += 1;
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  id: report.id,
  filename: report.filename,
  fileCount: report.entryCount,
  unpackedSize: report.unpackedSize,
  private: packageJson.private,
  sensitiveFindings: packageFindings.length,
  dependenciesAudited,
  publishAttempted: false,
}, null, 2)}\n`);
