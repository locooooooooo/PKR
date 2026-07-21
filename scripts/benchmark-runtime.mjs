#!/usr/bin/env node

import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { LpsOrchestrator, PkrRuntime, runLocalVerification } from "../dist/index.js";
import {
  emitReport,
  measured,
  option,
  parseIntegerOption,
  readProjectionDigest,
  referenceEnvironment,
  replaceStateFromSnapshot,
  repositoryRoot,
  statistics,
  temporaryGitProject,
} from "./performance-support.mjs";

const args = process.argv.slice(2);
const repetitions = parseIntegerOption(args, "--repetitions", 5, 1, 50);
const output = option(args, "--output");
const root = await temporaryGitProject("pkr-benchmark-");
const snapshotRoot = await mkdtemp(join(tmpdir(), "pkr-benchmark-snapshot-"));
const samples = Object.fromEntries(
  ["startup", "status", "claim", "submit", "verify", "projectionRebuild", "restore"].map((name) => [name, []]),
);

function value(result) {
  assert.ok(result.value, "expected committed Runtime value");
  return result.value;
}

try {
  let runtime = await PkrRuntime.init(root, repositoryRoot, {
    name: "benchmark",
    title: "Benchmark fixture",
    outcome: "Measure bounded local Runtime operations.",
  });
  const agent = value(await runtime.registerAgent("benchmark-agent", "local"));
  const agentId = agent.metadata.id;
  runtime.close();

  for (let index = 0; index < repetitions; index += 1) {
    const startup = await measured(() => PkrRuntime.open(root, repositoryRoot));
    runtime = startup.value;
    samples.startup.push(startup.durationMs);

    samples.status.push((await measured(() => Promise.resolve(runtime.status()))).durationMs);
    const goal = value(await runtime.createGoal(`Benchmark iteration ${index}`, "human_001", `command_benchmark_goal_${index}`));
    const task = value(await runtime.createTask(goal.metadata.id, `Benchmark lane ${index}`, "human_001", `command_benchmark_task_${index}`));
    const taskId = task.metadata.id;
    const lps = new LpsOrchestrator(runtime);
    const claim = await measured(() => lps.claim(taskId, agentId, `benchmark://iteration/${index}`));
    samples.claim.push(claim.durationMs);

    const resultPath = `benchmark-result-${index}.txt`;
    await writeFile(join(root, resultPath), `benchmark ${index}\n`, "utf8");
    const submit = await measured(() => lps.submit(claim.value.assignmentId, agentId, {
      outcome: "partial",
      completed: ["repository-change-produced"],
      incomplete: ["independent-verification", "acceptance"],
      blockers: [],
      evidenceIds: [],
      outputs: [{ kind: "patch", locator: resultPath }],
      nextAction: "Run independent repository Verification.",
    }));
    samples.submit.push(submit.durationMs);

    const plan = {
      version: "pkr.verify/v1",
      commands: [{ id: "bounded-check", executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 10_000 }],
      allowedPaths: ["benchmark-result-*/**", ...Array.from({ length: repetitions }, (_, item) => `benchmark-result-${item}.txt`)],
      forbiddenPaths: [".pkr/**"],
      requireChanges: true,
    };
    const verification = await measured(async () => {
      const evidence = await runLocalVerification(root, taskId, claim.value.assignmentId, plan);
      return runtime.verify(taskId, claim.value.assignmentId, "agent_benchmark_verifier", `command_benchmark_verify_${index}`, evidence);
    });
    assert.equal(verification.value.value.passed, true);
    samples.verify.push(verification.durationMs);

    const rebuild = await measured(() => runtime.rebuildProjections());
    samples.projectionRebuild.push(rebuild.durationMs);
    assert.equal(await readProjectionDigest(root), runtime.stateDigest());
    runtime.close();
  }

  runtime = await PkrRuntime.open(root, repositoryRoot);
  const expectedDigest = runtime.stateDigest();
  runtime.close();
  const snapshot = join(snapshotRoot, "state");
  await cp(join(root, ".pkr"), snapshot, { recursive: true });
  for (let index = 0; index < repetitions; index += 1) {
    const restored = await measured(async () => {
      await replaceStateFromSnapshot(root, snapshot);
      return PkrRuntime.open(root, repositoryRoot);
    });
    assert.equal(restored.value.stateDigest(), expectedDigest);
    restored.value.close();
    samples.restore.push(restored.durationMs);
  }

  await emitReport({
    version: "pkr.benchmark/v1",
    generatedAt: new Date().toISOString(),
    fixture: "synthetic local Git repository; no real Provider or production workload",
    referenceEnvironment: referenceEnvironment(),
    repetitions,
    semantics: {
      startup: "cold PkrRuntime.open after prior close",
      status: "SQLite-backed Runtime status and state digest",
      claim: "Agent-native claim including live Git evidence and projection rebuild",
      submit: "non-authoritative work report with live Git evidence; no acceptance",
      verify: "live repository collection, one local command, Repository Verification, and Runtime acceptance",
      projectionRebuild: "rebuild all derived projections from SQLite authority",
      restore: "benchmark harness copies a closed .pkr snapshot into place, opens it, and compares state digest; not a stable public restore API",
    },
    measurements: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, statistics(values)])),
    final: { stateDigest: expectedDigest, projectionDigest: await readProjectionDigest(root) },
  }, output);
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(snapshotRoot, { recursive: true, force: true });
}
