#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const output = outputIndex < 0 ? undefined : resolve(args[outputIndex + 1]);
if (args.some((argument, index) => argument.startsWith("--") && index !== outputIndex)) {
  throw new Error("usage: node scripts/dependency-report.mjs [--output <path>]");
}

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
const packageEntries = Object.entries(lock.packages ?? {}).filter(([path]) => path !== "");
const registryHosts = [...new Set(packageEntries.flatMap(([, entry]) => {
  if (typeof entry.resolved !== "string") return [];
  try { return [new URL(entry.resolved).host]; } catch { return ["non-url"]; }
}))].sort();
const missingIntegrity = packageEntries
  .filter(([, entry]) => typeof entry.resolved === "string" && !entry.integrity)
  .map(([path]) => path);
const lockedPackages = packageEntries.map(([path, entry]) => ({
  name: path.replace(/^node_modules\//, ""),
  version: entry.version ?? "unknown",
  license: entry.license ?? null,
  dev: entry.dev === true,
}));
const missingLicense = lockedPackages.filter((entry) => !entry.license).map((entry) => entry.name);

const auditArgs = ["audit", "--omit=dev", "--json"];
const audit = spawnSync(
  process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm",
  process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd", ...auditArgs] : auditArgs,
  { cwd: root, encoding: "utf8", timeout: 120_000 },
);
let auditPayload;
try {
  auditPayload = JSON.parse(audit.stdout || "{}");
} catch {
  auditPayload = {};
}
const vulnerabilities = auditPayload.metadata?.vulnerabilities ?? null;
const auditAvailable = audit.status === 0 || vulnerabilities !== null;
const passed = missingIntegrity.length === 0 && missingLicense.length === 0 && auditAvailable &&
  vulnerabilities !== null && (vulnerabilities.total ?? 0) === 0;
const report = {
  version: "pkr.dependency-review/v1",
  generatedAt: new Date().toISOString(),
  package: { name: packageJson.name, version: packageJson.version, private: packageJson.private },
  lockfileVersion: lock.lockfileVersion,
  directDependencies: packageJson.dependencies ?? {},
  directDevDependencies: packageJson.devDependencies ?? {},
  lockedPackageCount: packageEntries.length,
  lockedPackages,
  licenses: {
    counts: lockedPackages.reduce((counts, entry) => {
      const license = entry.license ?? "unknown";
      counts[license] = (counts[license] ?? 0) + 1;
      return counts;
    }, {}),
    missingLicense,
  },
  integrity: {
    entriesWithIntegrity: packageEntries.filter(([, entry]) => typeof entry.integrity === "string").length,
    missingIntegrity,
  },
  registryHosts,
  provenanceBoundary: "registry URL plus lockfile integrity; no signature, build attestation, or SLSA claim",
  npmAudit: {
    available: auditAvailable,
    status: audit.status,
    vulnerabilities,
    error: auditAvailable ? null : "npm audit did not return structured vulnerability metadata",
  },
  passed,
};
const encoded = `${JSON.stringify(report, null, 2)}\n`;
if (output) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, encoded, "utf8");
}
process.stdout.write(encoded);
process.exitCode = passed ? 0 : 1;
