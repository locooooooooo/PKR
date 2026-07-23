import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { assert, readJson, root } from "./release-utils.mjs";

const packageJson = readJson("package.json");
const contract = readJson("docs/release/v1-contract-manifest.json");
const version = readFileSync(resolve(root, "VERSION"), "utf8").trim();
const lock = readJson("package-lock.json");
const help = readFileSync(resolve(root, "src/cli-contract.ts"), "utf8");

assert(packageJson.version === version, "package.json and VERSION disagree");
assert(lock.version === version, "package-lock root version disagrees");
assert(lock.packages?.[""]?.version === version, "package-lock package version disagrees");
assert(contract.packageVersion === version, "contract packageVersion disagrees");
assert(version === "1.2.0", "v1.2 release candidate must use the accepted stable version");
assert(contract.status === "stable_contract_accepted", "v1 contract must be owner-accepted");
assert(packageJson.private === true, "npm publication is not authorized; package must remain private");
assert(packageJson.license === "Apache-2.0", "package license must match LICENSE");
assert(packageJson.engines?.node === ">=24 <25", "Node support must stay 24.x");
assert(help.includes(`PKR ${version} stable CLI`), "CLI help version disagrees");

process.stdout.write(`${JSON.stringify({
  ok: true,
  package: packageJson.name,
  version,
  private: packageJson.private,
  license: packageJson.license,
  node: packageJson.engines.node,
  targetContract: contract.targetVersion,
  contractStatus: contract.status,
}, null, 2)}\n`);
