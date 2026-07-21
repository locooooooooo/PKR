#!/usr/bin/env node

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

import { PkrRuntime } from "../dist/index.js";
import { PkrStore, commandContent } from "../dist/store.js";
import {
  emitReport,
  measured,
  option,
  parseIntegerOption,
  readProjectionDigest,
  referenceEnvironment,
  repositoryRoot,
  statistics,
  temporaryGitProject,
} from "./performance-support.mjs";

const args = process.argv.slice(2);
const cycles = parseIntegerOption(args, "--cycles", 100, 1, 2_000);
const seedEvents = parseIntegerOption(args, "--seed-events", 1_000, 0, 10_000);
const output = option(args, "--output");
const root = await temporaryGitProject("pkr-soak-");
const restartSamples = [];
const mutationSamples = [];
const startedAt = Date.now();
let peakRssBytes = process.memoryUsage().rss;

try {
  let runtime = await PkrRuntime.init(root, repositoryRoot, {
    name: "soak",
    title: "Soak fixture",
    outcome: "Exercise long event history and repeated Runtime restart.",
  });
  const projectId = runtime.projectId;
  runtime.close();
  const store = new PkrStore(`${root}/.pkr/runtime.sqlite`);
  for (let index = 0; index < seedEvents; index += 1) {
    const commandId = `command_soak_seed_${index}`;
    store.execute(
      projectId,
      commandId,
      commandContent({ action: "soakSeedEvent", index }),
      (transaction) => {
        const manifest = transaction.getRecord("ProjectManifest", projectId);
        assert.ok(manifest, "soak seed requires ProjectManifest authority");
        transaction.appendEvent(
          "pkr.soak.syntheticEventRecorded",
          "ProjectManifest",
          projectId,
          manifest.revision,
          { fixture: "synthetic-soak-marker", index },
        );
        return transaction.committed({ index });
      },
    );
  }
  store.close();
  runtime = await PkrRuntime.open(root, repositoryRoot);
  await runtime.rebuildProjections();
  let priorSequence = runtime.status().projectSequence;
  let priorDigest = runtime.stateDigest();
  runtime.close();

  for (let index = 0; index < cycles; index += 1) {
    const opened = await measured(() => PkrRuntime.open(root, repositoryRoot));
    runtime = opened.value;
    restartSamples.push(opened.durationMs);
    assert.equal(runtime.stateDigest(), priorDigest, `state drift before cycle ${index}`);
    assert.equal(runtime.status().projectSequence, priorSequence, `sequence drift before cycle ${index}`);
    assert.equal(await readProjectionDigest(root), priorDigest, `projection drift before cycle ${index}`);
    assert.equal(runtime.listRecords("Verification").length, 0, `silent Verification at cycle ${index}`);
    assert.equal(
      runtime.listRecords("Task").some((record) => record.data.status?.phase === "done"),
      false,
      `silent acceptance at cycle ${index}`,
    );

    const mutation = await measured(() => runtime.createGoal(
      `Soak cycle ${index}`,
      "human_001",
      `command_soak_goal_${index}`,
    ));
    mutationSamples.push(mutation.durationMs);
    const nextSequence = runtime.status().projectSequence;
    assert.ok(nextSequence > priorSequence, `event sequence did not advance at cycle ${index}`);
    priorSequence = nextSequence;
    priorDigest = runtime.stateDigest();
    assert.equal(await readProjectionDigest(root), priorDigest, `projection did not rebuild at cycle ${index}`);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    runtime.close();
  }

  runtime = await PkrRuntime.open(root, repositoryRoot);
  assert.equal(runtime.stateDigest(), priorDigest);
  assert.equal(runtime.status().projectSequence, priorSequence);
  assert.equal(runtime.listRecords("Verification").length, 0);
  assert.equal(await readProjectionDigest(root), priorDigest);
  const report = {
    version: "pkr.soak/v1",
    generatedAt: new Date().toISOString(),
    fixture: "synthetic local Git repository; marker events and Goal mutations intentionally cannot create Verification or acceptance",
    referenceEnvironment: referenceEnvironment(),
    cycles,
    seedEvents,
    loadComposition: {
      seed: "PkrStore transactions append synthetic ProjectManifest marker events without acceptance semantics",
      cycle: "cold Runtime open, digest and projection checks, one Runtime Goal mutation, close",
    },
    durationMs: Date.now() - startedAt,
    finalProjectSequence: priorSequence,
    finalEventCount: runtime.listEvents().length,
    finalRecordCount: runtime.listRecords().length,
    stateDigest: priorDigest,
    projectionDigest: await readProjectionDigest(root),
    verificationCount: runtime.listRecords("Verification").length,
    doneTaskCount: runtime.listRecords("Task").filter((record) => record.data.status?.phase === "done").length,
    peakProcessRssBytes: peakRssBytes,
    restart: statistics(restartSamples),
    mutationWithProjectionRebuild: statistics(mutationSamples),
    assertions: {
      restartStateDrift: false,
      projectionStateDrift: false,
      nonMonotonicEventSequence: false,
      silentVerification: false,
      silentAcceptance: false,
    },
  };
  runtime.close();
  await emitReport(report, output);
} finally {
  await rm(root, { recursive: true, force: true });
}
