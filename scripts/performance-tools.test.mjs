import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";

const temporaryRoots = [];

afterEach(async () => {
  while (temporaryRoots.length) await rm(temporaryRoots.pop(), { recursive: true, force: true });
});

function run(script, args) {
  return spawnSync(process.execPath, [resolve(script), ...args], { encoding: "utf8", timeout: 120_000 });
}

test("benchmark emits every declared operation with raw samples", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "pkr-benchmark-test-"));
  temporaryRoots.push(outputRoot);
  const output = join(outputRoot, "benchmark.json");
  const result = run("scripts/benchmark-runtime.mjs", ["--repetitions", "1", "--output", output]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(await readFile(output, "utf8"));
  for (const name of ["startup", "status", "claim", "submit", "verify", "projectionRebuild", "restore"]) {
    assert.equal(report.measurements[name].samplesMs.length, 1, `missing ${name}`);
  }
  assert.equal(report.fixture.includes("no live Agent host"), true);
});

test("soak restarts without state drift or silent acceptance", async () => {
  const result = run("scripts/soak-runtime.mjs", ["--cycles", "3", "--seed-events", "5"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.cycles, 3);
  assert.equal(report.seedEvents, 5);
  assert.equal(report.verificationCount, 0);
  assert.equal(report.doneTaskCount, 0);
  assert.equal(report.stateDigest, report.projectionDigest);
  assert.equal(Object.values(report.assertions).every((value) => value === false), true);
});
