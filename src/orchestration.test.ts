import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { PkrError } from "./errors.js";
import { LpsOrchestrator } from "./lps.js";
import { LocalProcessAdapter } from "./provider.js";
import { PkrRuntime } from "./runtime.js";
import { StewardService } from "./steward.js";
import type { JsonObject } from "./types.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerScript = resolve(repositoryRoot, "dist", "provider-worker.js");
const temporaryRoots: string[] = [];

function runCli(projectRoot: string, args: string[]): JsonObject {
  const result = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, "dist", "cli.js"), ...args, "--project", projectRoot],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as JsonObject;
}

async function project(name: string): Promise<{ root: string; runtime: PkrRuntime }> {
  const root = await mkdtemp(join(tmpdir(), `pkr-${name}-`));
  temporaryRoots.push(root);
  return {
    root,
    runtime: await PkrRuntime.init(root, repositoryRoot, {
      name,
      title: name,
      outcome: `Prove ${name}.`,
    }),
  };
}

afterEach(async () => {
  while (temporaryRoots.length) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

test("Steward separates proposals from truth and gates material changes", async () => {
  const { runtime } = await project("steward");
  const steward = new StewardService(runtime);

  const ordinary = steward.prepare("Add a bounded local status command");
  assert.equal(ordinary.state, "ready");
  assert.equal(runtime.listRecords("Goal").length, 0);
  const applied = await steward.apply(ordinary);
  assert.equal(runtime.listRecords("Goal").length, 1);
  assert.equal(runtime.listRecords("Task").length, 1);
  assert.equal(applied.decisionId, null);

  const material = steward.prepare(
    "Change the architecture and public contract for provider permissions",
  );
  assert.equal(material.state, "awaitingApproval");
  await assert.rejects(
    steward.apply(material),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-STEWARD-002",
  );
  await assert.rejects(
    steward.apply(material, "human_other"),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-STEWARD-002",
  );
  const approved = await steward.apply(material, runtime.ownerId());
  const decision = runtime.getRecord("Decision", approved.decisionId as string);
  assert.equal((decision.data.status as JsonObject).phase, "accepted");
  runtime.close();
});

test("LPS executes one real provider process and rebuilds its board from PKR", async () => {
  const { root, runtime } = await project("lps-process");
  const steward = new StewardService(runtime);
  const intake = await steward.apply(
    steward.prepare("Implement one provider process golden path"),
  );
  const agentResult = await runtime.registerAgent("process-worker", "local-process");
  const agentId = (((agentResult.value as JsonObject).metadata as JsonObject).id as string);
  const provider = new LocalProcessAdapter(process.execPath, workerScript);
  const lps = new LpsOrchestrator(runtime, provider);
  const before = runtime.listEvents().length;
  const result = await lps.executeLane(intake.taskId as string, agentId);
  assert.equal(result.callback?.outcome, "verified");
  assert.equal(
    (runtime.getRecord("Task", intake.taskId as string).data.status as JsonObject).phase,
    "done",
  );
  assert.equal(runtime.getRecord("AgentSession", result.sessionId).data.state, "closed");
  const completedRun = runtime
    .listRecords("WorkflowRun")
    .find(
      (record) =>
        ((record.data.scope as JsonObject).taskId as string) === intake.taskId,
    );
  assert.equal(completedRun?.data.state, "done");
  const board = lps.board();
  assert.equal((board.source as JsonObject).authority, "PKR");
  assert.equal(((board.workers as JsonObject[])[0]?.state as string), "archived");
  const eventCount = runtime.listEvents().length;
  assert.ok(eventCount > before);
  runtime.close();

  const reopened = await PkrRuntime.open(root, repositoryRoot);
  const rebuilt = new LpsOrchestrator(
    reopened,
    new LocalProcessAdapter(process.execPath, workerScript),
  ).board();
  assert.deepEqual(rebuilt, board);
  const reused = await new LpsOrchestrator(
    reopened,
    new LocalProcessAdapter(process.execPath, workerScript),
  ).executeLane(intake.taskId as string, agentId);
  assert.equal(reused.reused, true);
  assert.equal(reopened.listEvents().length, eventCount);
  reopened.close();
});

test("heartbeat, cancellation, expiry, and provider timeout fail closed", async () => {
  const { runtime } = await project("lifecycle");
  const steward = new StewardService(runtime);
  const agentResult = await runtime.registerAgent("lifecycle-worker", "local-process");
  const agentId = (((agentResult.value as JsonObject).metadata as JsonObject).id as string);
  const provider = new LocalProcessAdapter(process.execPath, workerScript);
  const lps = new LpsOrchestrator(runtime, provider);

  const cancellation = await steward.apply(steward.prepare("Test cancellation"));
  const dispatch = await runtime.dispatch(cancellation.taskId as string, agentId);
  const assignmentId = (dispatch.value as JsonObject).assignmentId as string;
  const heartbeat = await lps.heartbeat(assignmentId);
  assert.equal(runtime.getRecord("Lease", heartbeat.leaseId as string).data.state, "renewed");
  await lps.cancel(assignmentId, "OwnerCancelled");
  assert.equal(runtime.getRecord("Assignment", assignmentId).data.state, "cancelled");
  await assert.rejects(
    runtime.callback(assignmentId, "verified"),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-COORD-008",
  );

  const expiry = await steward.apply(steward.prepare("Test lease expiry"));
  const expiryDispatch = await runtime.dispatch(expiry.taskId as string, agentId);
  const expiryAssignment = (expiryDispatch.value as JsonObject).assignmentId as string;
  await lps.expire(expiryAssignment);
  assert.equal(runtime.getRecord("Assignment", expiryAssignment).data.state, "expired");
  assert.equal(
    (runtime.getRecord("Task", expiry.taskId as string).data.status as JsonObject).phase,
    "blocked",
  );
  await assert.rejects(
    runtime.callback(expiryAssignment, "verified"),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-COORD-008",
  );

  const timeout = await steward.apply(steward.prepare("Test provider timeout"));
  const slowLps = new LpsOrchestrator(
    runtime,
    new LocalProcessAdapter(process.execPath, workerScript, 10, {
      PKR_PROVIDER_DELAY_MS: "100",
    }),
  );
  await assert.rejects(
    slowLps.executeLane(timeout.taskId as string, agentId),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-COORD-006",
  );
  const timedOutAssignment = runtime
    .listRecords("Assignment")
    .find((record) => record.data.taskId === timeout.taskId)!;
  assert.equal(timedOutAssignment.data.state, "running");
  await slowLps.cancel(timedOutAssignment.id, "ProviderTimeout");
  assert.equal(timedOutAssignment.id.length > 0, true);
  runtime.close();
});

test("Steward and LPS CLI commands complete a process-boundary lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "pkr-orchestration-cli-"));
  temporaryRoots.push(root);
  runCli(root, [
    "init",
    "--name",
    "orchestration-cli",
    "--outcome",
    "Prove Steward and LPS CLI integration.",
  ]);
  const intake = runCli(root, [
    "steward",
    "apply",
    "--request",
    "Complete one orchestrated CLI lane",
  ]);
  const agent = runCli(root, [
    "agent",
    "register",
    "--name",
    "orchestration-worker",
    "--provider",
    "local-process",
  ]);
  const agentId = (((agent.value as JsonObject).metadata as JsonObject).id as string);
  const execution = runCli(root, [
    "lps",
    "run",
    "--task",
    intake.taskId as string,
    "--agent",
    agentId,
  ]);
  assert.equal((execution.callback as JsonObject).outcome, "verified");
  const board = runCli(root, ["lps", "board"]);
  assert.equal((board.source as JsonObject).authority, "PKR");
  assert.equal(((board.workers as JsonObject[])[0]?.state as string), "archived");
});
