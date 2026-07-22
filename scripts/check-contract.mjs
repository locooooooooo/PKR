import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

import { assert, compareExact, readJson, root, sortedUnique } from "./release-utils.mjs";

const manifest = readJson("docs/release/v1-contract-manifest.json");

const cliSource = readFileSync(resolve(root, "src/cli-contract.ts"), "utf8");
const cliRoutes = [...cliSource.matchAll(/command\(\s*"([^"]+)"/g)].map((match) => match[1]);
compareExact("CLI routes", cliRoutes, [...manifest.cli.stableCandidate, ...manifest.cli.experimental]);

const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
assert(configPath, "tsconfig.json was not found");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const indexSource = program.getSourceFile(resolve(root, "src/index.ts"));
assert(indexSource, "src/index.ts was not loaded by TypeScript");
const indexSymbol = checker.getSymbolAtLocation(indexSource);
assert(indexSymbol, "src/index.ts module symbol was not found");
const rootExports = checker.getExportsOfModule(indexSymbol).map((symbol) => symbol.name);
compareExact(
  "TypeScript exports",
  rootExports,
  [...manifest.typescriptExports.stableCandidate, ...manifest.typescriptExports.experimental],
);

const schemaPaths = manifest.schemas.map((schema) => schema.path);
const expectedSchemaPaths = [
  "schemas/v0.2/pkr-bootstrap.schema.json",
  "schemas/v0.2/pkr-object.schema.json",
  "schemas/v0.2/pkr-runtime.schema.json",
  "schemas/v0.4/pkr-agent.schema.json",
  "schemas/v0.4/pkr-context.schema.json",
  "schemas/v0.4/pkr-coordination-runtime.schema.json",
  "schemas/v0.4/pkr-coordination.schema.json",
  "schemas/v0.4/pkr-package.schema.json",
  "schemas/v0.4/pkr-workflow.schema.json",
];
compareExact("schema inventory", schemaPaths, expectedSchemaPaths);
for (const schema of manifest.schemas) {
  const value = readJson(schema.path);
  assert(typeof value.$id === "string" && value.$id.length > 0, `${schema.path} has no $id`);
  assert(value.$id.includes(schema.apiVersion.replace("pkr.dev/", "/")), `${schema.path} apiVersion does not match $id`);
}

const runtimeSource = readFileSync(resolve(root, "src/runtime.ts"), "utf8");
const eventTypes = [...runtimeSource.matchAll(/appendEvent\(\s*"([^"]+)"/g)].map((match) => match[1]);
compareExact(
  "Runtime event types",
  eventTypes,
  [...manifest.eventTypes.stableCandidate, ...manifest.eventTypes.experimental],
);

const writtenKinds = [...runtimeSource.matchAll(/(?:putRecord|seedRecord)\(\s*"([^"]+)"/g)]
  .map((match) => match[1]);
compareExact(
  "persisted record kinds",
  writtenKinds,
  [...manifest.persistedRecordKinds.stableCandidate, ...manifest.persistedRecordKinds.experimental],
);

const classifications = [
  ...Object.values(manifest.cli).flat(),
  ...Object.values(manifest.typescriptExports).flat(),
  ...Object.values(manifest.persistedRecordKinds).flat(),
  ...Object.values(manifest.eventTypes).flat(),
];
assert(classifications.length === sortedUnique(classifications).length, "contract contains duplicate classifications");

process.stdout.write(`${JSON.stringify({
  ok: true,
  cliRoutes: cliRoutes.length,
  typescriptExports: rootExports.length,
  schemas: schemaPaths.length,
  persistedRecordKinds: sortedUnique(writtenKinds).length,
  eventTypes: sortedUnique(eventTypes).length,
  contractStatus: manifest.status,
}, null, 2)}\n`);
