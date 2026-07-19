import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

assert.equal(packageJson.name, "pkr-runtime");
assert.equal(packageJson.version, "0.7.0-alpha.1");
assert.equal(packageJson.private, undefined);
assert.equal(packageJson.license, "Apache-2.0");
assert.equal(packageJson.bin.pkr, "./dist/cli.js");
assert.equal(packageJson.publishConfig.access, "public");

const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const args = process.platform === "win32"
  ? ["/d", "/s", "/c", "npm pack --dry-run --json --ignore-scripts"]
  : ["pack", "--dry-run", "--json", "--ignore-scripts"];
const packResult = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true });
assert.equal(packResult.status, 0, packResult.stderr || packResult.stdout);
const output = packResult.stdout;
const manifest = JSON.parse(output)[0];
const files = manifest.files.map((entry) => entry.path);
const required = [
  "LICENSE",
  "README.md",
  "VERSION",
  "dist/cli.js",
  "dist/index.js",
  "schemas/v0.2/pkr-object.schema.json",
  "schemas/v0.4/pkr-coordination.schema.json",
];
for (const path of required) {
  assert.ok(files.includes(path), `package is missing ${path}`);
}
for (const path of files) {
  assert.doesNotMatch(path, /(^|\/)(\.pkr|iterations|release|node_modules)(\/|$)/);
}
console.log(`PASS: npm package ${manifest.name}@${manifest.version} contains ${files.length} public files.`);
