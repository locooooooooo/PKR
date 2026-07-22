import { lstatSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

import { assert, publicTree, root } from "./release-utils.mjs";

const { manifest, publicFiles, privateFiles, unknownFiles } = publicTree();

assert(unknownFiles.length === 0, `unclassified candidate paths: ${unknownFiles.join(", ")}`);
for (const required of manifest.requiredPaths) {
  assert(publicFiles.includes(required), `required public path is missing: ${required}`);
}

assert(publicFiles.some((path) => path.startsWith("src/") && path.endsWith(".ts")), "public tree has no Runtime source");
assert(publicFiles.some((path) => path.startsWith("src/") && path.endsWith(".test.ts")), "public tree has no Runtime tests");
assert(!publicFiles.some((path) => path.startsWith("iterations/")), "private iteration evidence entered the public tree");

let jsonFiles = 0;
const brandNames = [
  "Co" + "dex",
  "Clau" + "de",
  "Open" + "AI",
  "Anthro" + "pic",
  "Gem" + "ini",
  "Q" + "wen",
  "G" + "PT",
];
const brandSpecific = new RegExp(`\\b(?:${brandNames.join("|")})\\b`, "i");
for (const path of publicFiles) {
  const absolute = resolve(root, path);
  assert(!lstatSync(absolute).isSymbolicLink(), `public tree contains a symbolic link: ${path}`);
  const content = readFileSync(absolute);
  if (!content.includes(0) && brandSpecific.test(content.toString("utf8"))) {
    assert(
      path.startsWith("docs/integrations/"),
      `brand-specific product signal must stay in optional integration docs: ${path}`,
    );
  }
  if (extname(path) === ".json") {
    JSON.parse(content.toString("utf8"));
    jsonFiles += 1;
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  publicFiles: publicFiles.length,
  privateFilesExcluded: privateFiles.length,
  jsonFilesParsed: jsonFiles,
  includesRuntimeSource: true,
  includesRuntimeTests: true,
  brandSpecificSignalsConfined: true,
}, null, 2)}\n`);
