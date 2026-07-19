import assert from "node:assert/strict";
import test from "node:test";

import { increment } from "../src/counter.js";

test("increment returns the next integer", () => {
  assert.equal(increment(41), 42);
});
