import test from "node:test";
import assert from "node:assert/strict";

import {
  compareExact,
  isPrivatePath,
  isPublicPath,
  normalizePath,
  readJson,
  sortedUnique,
} from "./release-utils.mjs";

const manifest = readJson("scripts/public-tree.json");

test("public-tree classifier keeps source and private iteration evidence separate", () => {
  assert.equal(isPublicPath("src\\runtime.ts", manifest), true);
  assert.equal(isPublicPath("docs/architecture.md", manifest), true);
  assert.equal(isPrivatePath("iterations/private-note.md", manifest), true);
  assert.equal(isPublicPath("iterations/private-note.md", manifest), false);
  assert.equal(isPrivatePath("docs/internal/decision.md", manifest), true);
  assert.equal(isPublicPath("docs/internal/decision.md", manifest), false);
});

test("path normalization and exact inventory comparison are deterministic", () => {
  assert.equal(normalizePath(".\\docs\\quickstart.md"), "docs/quickstart.md");
  assert.deepEqual(sortedUnique(["b", "a", "b"]), ["a", "b"]);
  assert.doesNotThrow(() => compareExact("sample", ["b", "a"], ["a", "b"]));
  assert.throws(() => compareExact("sample", ["a"], ["b"]), /drifted/);
});
