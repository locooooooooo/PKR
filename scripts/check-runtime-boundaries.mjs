import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src");
const allowed = {
  types: [],
  errors: [],
  util: ["types"],
  process: [],
  contracts: ["errors"],
  objects: ["types", "util"],
  workflow: ["errors", "types"],
  profiles: ["types", "workflow"],
  store: ["errors", "types", "util"],
  projection: ["store", "types", "util"],
  workspace: ["errors", "process", "util"],
  verifier: ["errors", "process", "types", "util", "workspace"],
  runtime: ["contracts", "errors", "objects", "profiles", "projection", "store", "types", "util", "workspace", "workflow"],
  memory: ["runtime", "types"],
  codex: ["errors", "provider", "types", "util"],
  packages: ["errors", "profiles", "runtime", "types"],
  provider: ["errors", "types"],
  "provider-worker": [],
  lps: ["errors", "provider", "runtime", "types", "util"],
  steward: ["errors", "runtime", "types", "util"],
  cli: ["codex", "errors", "lps", "memory", "packages", "profiles", "provider", "runtime", "steward", "types", "util", "verifier"],
  index: ["codex", "contracts", "errors", "lps", "memory", "packages", "profiles", "provider", "runtime", "steward", "store", "types", "verifier", "workspace", "workflow"],
};

const failures = [];
for (const name of await readdir(source)) {
  if (extname(name) !== ".ts" || name.endsWith(".test.ts")) {
    continue;
  }
  const moduleName = basename(name, ".ts");
  const permitted = allowed[moduleName];
  if (!permitted) {
    failures.push(`${name}: module is missing from the boundary catalog`);
    continue;
  }
  const text = await readFile(join(source, name), "utf8");
  for (const match of text.matchAll(/from\s+["']\.\/([^"']+)\.js["']/g)) {
    const dependency = match[1];
    if (!dependency || !permitted.includes(dependency)) {
      failures.push(`${name}: import of ${dependency ?? "unknown"} violates dependency direction`);
    }
  }
}

if (failures.length) {
  console.error("FAIL: reference Runtime module boundaries");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("PASS: reference Runtime module dependency direction.");
}
