import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src");
const allowed = {
  types: [],
  errors: [],
  util: ["types"],
  clarification: ["errors", "question-sheet", "runtime", "types", "util", "workflow"],
  contracts: ["errors"],
  objects: ["types", "util"],
  workflow: ["errors", "types"],
  profiles: ["types", "workflow"],
  process: [],
  "path-safety": [],
  security: ["process", "types", "util"],
  workspace: ["errors", "process", "util"],
  verifier: ["errors", "process", "security", "types", "util", "workspace"],
  "evolution-model": ["errors", "profiles", "provider-contract", "security", "types", "util", "workflow"],
  "repository-evidence": ["errors", "types", "util"],
  store: ["errors", "repository-evidence", "types", "util"],
  projection: ["store", "types", "util"],
  runtime: ["contracts", "errors", "evolution-model", "objects", "profiles", "projection", "provider-contract", "repository-evidence", "store", "types", "util", "workflow"],
  evolution: ["evolution-model", "runtime", "types"],
  memory: ["runtime", "types"],
  packages: ["errors", "profiles", "runtime", "types"],
  "question-sheet": ["errors", "types", "util"],
  "question-sheet-renderer": ["errors", "question-sheet"],
  "project-manager": ["errors", "preflight", "process", "question-sheet", "runtime", "types", "util", "verifier"],
  "provider-contract": ["types"],
  provider: ["errors", "process", "provider-contract", "security", "types"],
  "provider-worker": ["path-safety"],
  preflight: ["errors", "provider", "runtime", "types", "verifier", "workspace"],
  "cli-contract": [],
  lps: ["errors", "provider", "runtime", "security", "types", "util", "workspace"],
  steward: ["clarification", "errors", "question-sheet", "runtime", "types", "util"],
  cli: ["clarification", "cli-contract", "errors", "evolution", "evolution-model", "lps", "memory", "packages", "preflight", "profiles", "project-manager", "provider", "question-sheet-renderer", "runtime", "security", "steward", "types", "verifier", "workspace"],
  index: ["clarification", "contracts", "errors", "evolution", "evolution-model", "lps", "memory", "packages", "path-safety", "preflight", "process", "profiles", "project-manager", "provider", "question-sheet", "question-sheet-renderer", "repository-evidence", "runtime", "security", "steward", "store", "types", "verifier", "workflow", "workspace"],
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
