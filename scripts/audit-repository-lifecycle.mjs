#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { LpsOrchestrator, PkrRuntime, runLocalVerification } from "../dist/index.js";
import {
  emitReport,
  option,
  referenceEnvironment,
  repositoryRoot,
  temporaryGitProject,
} from "./performance-support.mjs";

const output = option(process.argv.slice(2), "--output");
const roots = [];

function committed(result) {
  assert.ok(result.value, "expected committed Runtime value");
  return result.value;
}

function objectId(value) {
  return value.metadata.id;
}

function verificationPlan(allowedPaths, passCommand) {
  return {
    version: "pkr.verify/v1",
    commands: [{
      id: passCommand ? "repository-check" : "intentional-failure",
      executable: process.execPath,
      args: ["-e", passCommand ? "process.exit(0)" : "process.exit(7)"],
      timeoutMs: 10_000,
    }],
    allowedPaths,
    forbiddenPaths: [".pkr/**"],
    requireChanges: true,
  };
}

function gateSummary(runtime) {
  return runtime.listRecords("Verification")
    .map((record) => ({
      gate: record.data.spec.gate,
      phase: record.data.status.phase,
    }))
    .sort((left, right) => left.gate.localeCompare(right.gate));
}

function eventRange(runtime, startSequence) {
  const events = runtime.listEvents().filter((event) => event.sequence > startSequence);
  assert.ok(events.length > 0, "repository lifecycle scenario emitted no Runtime events");
  return {
    from: events[0].sequence,
    to: events.at(-1).sequence,
    count: events.length,
  };
}

async function initializedScenario(prefix, outcome) {
  const root = await temporaryGitProject(prefix);
  roots.push(root);
  const runtime = await PkrRuntime.init(root, repositoryRoot, {
    name: prefix.replace(/[^a-z0-9]+/g, "-"),
    title: "Repository lifecycle audit",
    outcome,
  });
  return { root, runtime, startSequence: runtime.status().projectSequence };
}

async function successScenario() {
  const { root, runtime, startSequence } = await initializedScenario(
    "pkr-audit-success-",
    "Complete only after independent repository Verification.",
  );
  const goal = committed(await runtime.createGoal("Produce one bounded repository result."));
  const task = committed(await runtime.createTask(objectId(goal), "Create the declared result file."));
  const agent = committed(await runtime.registerAgent("audit-producer", "external-host"));
  const taskId = objectId(task);
  const agentId = objectId(agent);
  const lps = new LpsOrchestrator(runtime);
  const claim = await lps.claim(taskId, agentId, "audit://success/producer");

  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "audit-success.txt"), "verified repository result\n", "utf8");
  await lps.submit(claim.assignmentId, agentId, {
    outcome: "partial",
    completed: ["repository-change-produced"],
    incomplete: ["independent-verification", "acceptance"],
    blockers: [],
    evidenceIds: [],
    outputs: [{ kind: "patch", locator: "src/audit-success.txt" }],
    nextAction: "Run independent repository Verification.",
  });

  const phaseAfterWorkReport = runtime.getRecord("Task", taskId).data.status.phase;
  const verificationCountAfterWorkReport = runtime.listRecords("Verification").length;
  const evidence = await runLocalVerification(
    root,
    taskId,
    claim.assignmentId,
    verificationPlan(["src/**"], true),
  );
  const verified = committed(await runtime.verify(
    taskId,
    claim.assignmentId,
    "agent_repository_verifier",
    "command_repository_audit_success",
    evidence,
  ));
  const finalDigest = runtime.stateDigest();
  const finalPhase = runtime.getRecord("Task", taskId).data.status.phase;
  const gates = gateSummary(runtime);
  const range = eventRange(runtime, startSequence);
  runtime.close();

  const reopened = await PkrRuntime.open(root, repositoryRoot);
  const restartDigestMatch = reopened.stateDigest() === finalDigest;
  const restartPhase = reopened.getRecord("Task", taskId).data.status.phase;
  reopened.close();

  assert.equal(phaseAfterWorkReport, "verifying");
  assert.equal(verificationCountAfterWorkReport, 0);
  assert.equal(verified.passed, true);
  assert.equal(finalPhase, "done");
  assert.deepEqual(gates, [
    { gate: "acceptance", phase: "passed" },
    { gate: "test", phase: "passed" },
  ]);
  assert.equal(restartDigestMatch, true);
  assert.equal(restartPhase, "done");

  return {
    workReportAuthority: "non_authoritative",
    phaseAfterWorkReport,
    verificationCountAfterWorkReport,
    repositoryVerificationPassed: true,
    runtimeAcceptanceRecorded: true,
    finalTaskPhase: finalPhase,
    restartDigestMatch,
    eventRange: range,
  };
}

async function failureScenario() {
  const { root, runtime, startSequence } = await initializedScenario(
    "pkr-audit-failure-",
    "Block work that fails repository scope or command Verification.",
  );
  const goal = committed(await runtime.createGoal("Prove fail-closed Verification."));
  const task = committed(await runtime.createTask(objectId(goal), "Reject the out-of-scope result."));
  const agent = committed(await runtime.registerAgent("audit-failure-producer", "external-host"));
  const taskId = objectId(task);
  const agentId = objectId(agent);
  const lps = new LpsOrchestrator(runtime);
  const claim = await lps.claim(taskId, agentId, "audit://failure/producer");

  await writeFile(join(root, "outside.txt"), "outside declared scope\n", "utf8");
  await lps.submit(claim.assignmentId, agentId, {
    outcome: "partial",
    completed: ["provider-work-report"],
    incomplete: ["repository-verification", "acceptance"],
    blockers: [],
    evidenceIds: [],
    outputs: [{ kind: "patch", locator: "outside.txt" }],
    nextAction: "Run independent repository Verification.",
  });
  const evidence = await runLocalVerification(
    root,
    taskId,
    claim.assignmentId,
    verificationPlan(["src/**"], false),
  );
  const verified = committed(await runtime.verify(
    taskId,
    claim.assignmentId,
    "agent_repository_verifier",
    "command_repository_audit_failure",
    evidence,
  ));
  const finalDigest = runtime.stateDigest();
  const finalPhase = runtime.getRecord("Task", taskId).data.status.phase;
  const assignmentState = runtime.getRecord("Assignment", claim.assignmentId).data.state;
  const gates = gateSummary(runtime);
  const range = eventRange(runtime, startSequence);
  runtime.close();

  const reopened = await PkrRuntime.open(root, repositoryRoot);
  const restartDigestMatch = reopened.stateDigest() === finalDigest;
  const restartPhase = reopened.getRecord("Task", taskId).data.status.phase;
  const acceptanceCountAfterRestart = reopened.listRecords("Verification")
    .filter((record) => record.data.spec.gate === "acceptance").length;
  reopened.close();

  assert.equal(verified.passed, false);
  assert.equal(evidence.reason, "RepositoryScopeFailed");
  assert.equal(finalPhase, "blocked");
  assert.equal(assignmentState, "failed");
  assert.deepEqual(gates, [{ gate: "test", phase: "failed" }]);
  assert.equal(restartDigestMatch, true);
  assert.equal(restartPhase, "blocked");
  assert.equal(acceptanceCountAfterRestart, 0);

  return {
    repositoryVerificationPassed: false,
    failureReason: evidence.reason,
    commandExitCode: evidence.commands[0].exitCode,
    finalTaskPhase: finalPhase,
    assignmentState,
    runtimeAcceptanceRecorded: false,
    restartDigestMatch,
    restartTaskPhase: restartPhase,
    eventRange: range,
  };
}

async function recoveryScenario() {
  const { runtime, startSequence } = await initializedScenario(
    "pkr-audit-recovery-",
    "Recover interrupted work without duplicate live Assignments.",
  );
  const root = runtime.paths.root;
  const goal = committed(await runtime.createGoal("Prove restart reassignment."));
  const task = committed(await runtime.createTask(objectId(goal), "Recover one expired Assignment."));
  const firstAgent = committed(await runtime.registerAgent("audit-first-agent", "external-host"));
  const secondAgent = committed(await runtime.registerAgent("audit-second-agent", "external-host"));
  const taskId = objectId(task);
  const lps = new LpsOrchestrator(runtime);
  const firstClaim = await lps.claim(taskId, objectId(firstAgent), "audit://recovery/first");
  await lps.expire(firstClaim.assignmentId);
  const expiredDigest = runtime.stateDigest();
  runtime.close();

  const reopened = await PkrRuntime.open(root, repositoryRoot);
  assert.equal(reopened.stateDigest(), expiredDigest);
  const secondClaim = await new LpsOrchestrator(reopened).claim(
    taskId,
    objectId(secondAgent),
    "audit://recovery/second",
  );
  const assignments = reopened.listRecords("Assignment");
  const liveAssignments = assignments.filter((record) =>
    ["offered", "accepted", "running", "submitted"].includes(record.data.state));
  const verificationCount = reopened.listRecords("Verification").length;
  const doneTaskCount = reopened.listRecords("Task")
    .filter((record) => record.data.status.phase === "done").length;
  const range = eventRange(reopened, startSequence);

  assert.notEqual(firstClaim.assignmentId, secondClaim.assignmentId);
  assert.equal(assignments.length, 2);
  assert.equal(liveAssignments.length, 1);
  assert.equal(verificationCount, 0);
  assert.equal(doneTaskCount, 0);
  reopened.close();

  return {
    expiredAssignmentState: "expired",
    reassignedAfterRestart: true,
    assignmentCount: assignments.length,
    liveAssignmentCount: liveAssignments.length,
    verificationCount,
    doneTaskCount,
    silentAcceptance: false,
    eventRange: range,
  };
}

try {
  await emitReport({
    version: "pkr.repository-lifecycle-audit/v1",
    generatedAt: new Date().toISOString(),
    evidenceClass: "automated_repository_fixture",
    fixture: "disposable local Git repositories; no real Provider or newcomer claim",
    referenceEnvironment: referenceEnvironment(),
    success: await successScenario(),
    verificationFailure: await failureScenario(),
    restartRecovery: await recoveryScenario(),
    assertions: {
      providerReportCreatedAcceptance: false,
      failedVerificationCreatedAcceptance: false,
      restartCreatedDuplicateLiveWork: false,
    },
  }, output);
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
