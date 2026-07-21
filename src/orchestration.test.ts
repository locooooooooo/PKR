import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ClarificationService } from "./clarification.js";
import { PkrError } from "./errors.js";
import { LpsOrchestrator } from "./lps.js";
import { LocalProcessAdapter } from "./provider.js";
import { resolveQuestionSheet } from "./question-sheet.js";
import { PkrRuntime } from "./runtime.js";
import { StewardService } from "./steward.js";
import type { JsonObject } from "./types.js";
import { runLocalVerification, type VerificationPlan } from "./verifier.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerScript = resolve(repositoryRoot, "dist", "provider-worker.js");
const temporaryRoots: string[] = [];

function invokeCli(projectRoot: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [resolve(repositoryRoot, "dist", "cli.js"), ...args, "--project", projectRoot],
    { encoding: "utf8" },
  );
}

function runCli(projectRoot: string, args: string[]): JsonObject {
  const result = invokeCli(projectRoot, args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as JsonObject;
}

function runCliFailure(projectRoot: string, args: string[]): JsonObject {
  const result = invokeCli(projectRoot, args);
  assert.notEqual(result.status, 0, result.stdout);
  const payload = result.stderr.trim().split(/\r?\n/).at(-1);
  assert.ok(payload, result.stderr);
  return JSON.parse(payload) as JsonObject;
}

function preflightCheck(report: JsonObject, id: string): JsonObject {
  const check = (report.checks as JsonObject[]).find((candidate) => candidate.id === id);
  assert.ok(check, `missing preflight check ${id}`);
  return check;
}

function localProviderConfig(executable: string, adapterId = "pkr.adapter.local-process"): JsonObject {
  return {
    version: "pkr.provider/v1",
    adapter: {
      id: adapterId,
      version: "0.6.0",
      capabilities: ["filesystem.read", "filesystem.write", "terminal"],
    },
    command: {
      executable,
      args: ["provider.mjs"],
      timeoutMs: 10_000,
    },
  };
}

async function initializeGitRepository(root: string): Promise<void> {
  const init = spawnSync("git", ["init", "-b", "main"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  await writeFile(join(root, ".gitignore"), ".pkr/\n", "utf8");
  await writeFile(join(root, "README.md"), "# Test repository\n", "utf8");
  assert.equal(spawnSync("git", ["add", "."], { cwd: root }).status, 0);
  const commit = spawnSync(
    "git",
    ["-c", "user.name=PKR Test", "-c", "user.email=pkr@example.invalid", "commit", "-m", "baseline"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(commit.status, 0, commit.stderr);
}

function verificationPlan(allowedPaths: string[], requireChanges: boolean): VerificationPlan {
  return {
    version: "pkr.verify/v1",
    commands: [{
      id: "repository-check",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 10_000,
    }],
    allowedPaths,
    forbiddenPaths: [".pkr/**"],
    requireChanges,
  };
}

async function project(name: string): Promise<{ root: string; runtime: PkrRuntime }> {
  const root = await mkdtemp(join(tmpdir(), `pkr-${name}-`));
  temporaryRoots.push(root);
  await initializeGitRepository(root);
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

test("CLI help and unknown options are side-effect free", async () => {
  const root = await mkdtemp(join(tmpdir(), "pkr-cli-help-"));
  temporaryRoots.push(root);
  await initializeGitRepository(root);

  const topLevelCommands = [
    "doctor", "init", "setup", "run", "status", "goal", "decision", "task", "agent", "dispatch",
    "callback", "verify", "events", "workspace", "memory", "profile", "workflow",
    "package", "prompt", "policy", "adapter", "metric", "evolution", "steward",
    "clarification", "lps", "assignment", "lease", "digest", "projection", "diagnostics",
  ];
  for (const command of topLevelCommands) {
    const help = invokeCli(root, [command, "--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stderr, "");
    assert.match(help.stdout, new RegExp(`Usage: pkr ${command.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`));
  }

  const initHelp = invokeCli(root, ["init", "--help"]);
  assert.equal(initHelp.status, 0, initHelp.stderr);
  assert.equal(existsSync(join(root, ".pkr")), false);

  const unknownCommand = invokeCli(root, ["unknown-command", "--project", root]);
  assert.equal(unknownCommand.status, 1);
  assert.equal(unknownCommand.stdout, "");
  assert.match(unknownCommand.stderr, /unknown command unknown-command/);
  assert.equal(existsSync(join(root, ".pkr")), false);

  const unknownOption = invokeCli(root, ["init", "--unknown", "value", "--project", root]);
  assert.equal(unknownOption.status, 1);
  assert.equal(unknownOption.stdout, "");
  assert.match(unknownOption.stderr, /unknown option --unknown/);
  assert.equal(existsSync(join(root, ".pkr")), false);

  const setupWithoutMode = invokeCli(root, ["setup"]);
  assert.equal(setupWithoutMode.status, 1);
  assert.match(setupWithoutMode.stderr, /setup requires --quickstart/);
  assert.equal(existsSync(join(root, ".pkr")), false);

  runCli(root, ["init", "--name", "help-safe", "--outcome", "Prove help safety"]);
  const before = runCli(root, ["digest"]);
  const initializedUnknownOption = invokeCli(root, ["status", "--unknown", "value"]);
  assert.equal(initializedUnknownOption.status, 1);
  assert.match(initializedUnknownOption.stderr, /unknown option --unknown/);
  assert.equal(runCli(root, ["digest"]).digest, before.digest);
});

test("CLI setup quickstart copies only verification fixtures and preserves Runtime authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "pkr-setup-cli-"));
  temporaryRoots.push(root);
  await initializeGitRepository(root);
  runCli(root, ["init", "--name", "setup-cli"]);

  const before = runCli(root, ["digest"]);
  const first = runCli(root, ["setup", "--quickstart"]);
  assert.deepEqual(first.created, ["verification.json", "verify.mjs"]);
  assert.deepEqual(first.skipped, []);
  assert.deepEqual(first.overwritten, []);
  assert.equal(first.targetPath, join(root, ".pkr"));
  assert.match(first.nextCommand as string, /^pkr doctor --project /);
  assert.equal(existsSync(join(root, ".pkr", "provider.json")), false);
  assert.equal(existsSync(join(root, ".pkr", "provider.mjs")), false);
  assert.equal(typeof JSON.parse(await readFile(join(root, ".pkr", "verification.json"), "utf8")), "object");
  assert.equal(existsSync(join(root, ".pkr", "verify.mjs")), true);
  assert.equal(runCli(root, ["digest"]).digest, before.digest);
});

test("CLI setup quickstart skips existing files by default and force overwrites them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pkr-setup-force-"));
  temporaryRoots.push(root);
  await initializeGitRepository(root);
  runCli(root, ["init", "--name", "setup-force"]);
  runCli(root, ["setup", "--quickstart"]);
  await writeFile(join(root, ".pkr", "verify.mjs"), "custom verification\n", "utf8");

  const skipped = runCli(root, ["setup", "--quickstart"]);
  assert.deepEqual(skipped.created, []);
  assert.deepEqual(skipped.skipped, ["verification.json", "verify.mjs"]);
  assert.deepEqual(skipped.overwritten, []);
  assert.equal(await readFile(join(root, ".pkr", "verify.mjs"), "utf8"), "custom verification\n");

  const forced = runCli(root, ["setup", "--quickstart", "--force"]);
  assert.deepEqual(forced.created, []);
  assert.deepEqual(forced.skipped, []);
  assert.deepEqual(forced.overwritten, ["verification.json", "verify.mjs"]);
  assert.equal(
    await readFile(join(root, ".pkr", "verify.mjs"), "utf8"),
    await readFile(join(repositoryRoot, "examples", "quickstart", "verify.mjs"), "utf8"),
  );
});

test("CLI setup quickstart fails before writing an uninitialized repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "pkr-setup-uninitialized-"));
  temporaryRoots.push(root);
  await initializeGitRepository(root);

  const failure = runCliFailure(root, ["setup", "--quickstart"]);
  assert.equal(failure.code, "PKR-RUNTIME-007");
  assert.match(failure.message as string, /run pkr init first/);
  assert.equal(existsSync(join(root, ".pkr")), false);
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
  assert.ok(material.questionSheet);
  const skippedQuestionSheet = resolveQuestionSheet(material.questionSheet, {
    action: "skip",
    answers: {},
  });
  assert.equal(skippedQuestionSheet.state, "blocked");
  assert.deepEqual(skippedQuestionSheet.blockedActions, ["apply_steward_proposal"]);
  const recommendedQuestionSheet = resolveQuestionSheet(material.questionSheet, {
    action: "accept_recommended",
    answers: {},
  });
  assert.equal(recommendedQuestionSheet.state, "blocked");
  assert.equal(recommendedQuestionSheet.unresolvedQuestionIds.length, 0);
  assert.deepEqual(recommendedQuestionSheet.blockedActions, ["apply_steward_proposal"]);
  const approvedQuestionSheet = resolveQuestionSheet(material.questionSheet, {
    action: "submit",
    answers: { "protected-decision": "approve" },
  });
  assert.equal(approvedQuestionSheet.state, "resolved");
  assert.deepEqual(approvedQuestionSheet.blockedActions, []);
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
  const ordinaryQuestionSheet = steward.prepare("Add a bounded local status command");
  assert.equal(ordinaryQuestionSheet.questionSheet, null);

  const vague = steward.prepare("优化一下这个项目");
  assert.equal(vague.state, "awaitingClarification");
  assert.ok(vague.questionSheet);
  const goalCountBeforeClarification = runtime.listRecords("Goal").length;
  await assert.rejects(
    steward.apply(vague),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-STEWARD-003",
  );
  assert.equal(runtime.listRecords("Goal").length, goalCountBeforeClarification);
  const clarified = await steward.apply(vague, undefined, { action: "skip", answers: {} });
  assert.equal(typeof clarified.clarificationRunId, "string");
  const clarifiedGoal = runtime.getRecord("Goal", clarified.goalId as string).data;
  assert.match((clarifiedGoal.spec as JsonObject).outcome as string, /First inspect the current state/);

  const forked = steward.prepare("Choose which architecture option should change the security permission model");
  assert.equal(forked.state, "awaitingApproval");
  assert.equal(forked.questionSheet?.questions.some((question) => question.id === "decision-direction"), true);
  await assert.rejects(
    steward.apply(forked, runtime.ownerId()),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-STEWARD-003",
  );
  const directed = await steward.apply(forked, runtime.ownerId(), {
    action: "submit",
    answers: {
      "decision-direction": "Adopt the least-privilege architecture and preserve API compatibility.",
      "protected-decision": "approve",
    },
  });
  const directedGoal = runtime.getRecord("Goal", directed.goalId as string).data;
  assert.equal(
    (directedGoal.spec as JsonObject).outcome,
    "Adopt the least-privilege architecture and preserve API compatibility.",
  );
  runtime.close();
});

test("clarification state survives restart and protected recommendations fail closed", async () => {
  const { root, runtime } = await project("clarification");
  const subject = runtime.getRecord("ProjectManifest", runtime.projectId);
  const input = {
    trigger: "steward-request" as const,
    subject: { kind: subject.kind, id: subject.id, revision: subject.revision },
    intent: "Change the security and permission model.",
  };
  const service = new ClarificationService(runtime);
  const assessed = await service.assess(input);
  assert.equal(assessed.state, "blocked");
  assert.deepEqual(assessed.blockedActions, ["apply_steward_proposal"]);
  assert.ok(assessed.questionSheet);
  const assessedRunRecord = runtime.getRecord("WorkflowRun", assessed.runId);
  const assessedRun = assessedRunRecord.data;
  const governanceWorkflowId = (subject.data.governance as JsonObject).governanceWorkflowId;
  assert.notEqual(assessedRun.workflowId, governanceWorkflowId);
  const clarificationWorkflowRecord = runtime.getRecord("Workflow", assessedRun.workflowId as string);
  const clarificationWorkflow = clarificationWorkflowRecord.data;
  assert.equal(((clarificationWorkflow.status as JsonObject).phase), "active");
  assert.deepEqual(
    (clarificationWorkflow.spec as JsonObject).appliesTo,
    ["Goal", "Decision", "Task"],
  );
  assert.equal(assessedRun.workflowRevision, clarificationWorkflowRecord.revision);
  const clarificationExtension = (assessedRun.extensions as JsonObject)["pkr.clarification/v1"] as JsonObject;
  await assert.rejects(
    runtime.transitionClarificationRun(
      assessed.runId,
      "assessing",
      clarificationExtension,
      false,
      "reject an undeclared transition",
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-CLARIFICATION-003",
  );
  assert.equal(runtime.getRecord("WorkflowRun", assessed.runId).revision, assessed.revision);

  const retried = await service.assess(input);
  assert.equal(retried.runId, assessed.runId);
  assert.equal(retried.revision, assessed.revision);

  const deferred = await service.respond(assessed.runId, {
    action: "accept_recommended",
    answers: {},
  });
  assert.equal(deferred.state, "blocked");
  assert.deepEqual(deferred.blockedActions, ["apply_steward_proposal"]);
  const retriedResponse = await service.respond(assessed.runId, {
    action: "accept_recommended",
    answers: {},
  });
  assert.equal(retriedResponse.revision, deferred.revision);

  const vague = await service.assess({
    trigger: "goal-review",
    subject: { kind: "Goal", id: "goal_vague_001", revision: 1 },
    intent: "优化一下这个项目",
  });
  assert.equal(vague.state, "awaiting-answers");
  assert.equal(vague.assessment.shouldAsk, true);
  const defaulted = await service.respond(vague.runId, { action: "skip", answers: {} });
  assert.equal(defaulted.state, "resolved");
  assert.equal(defaulted.resolution?.answers[0]?.source, "recommendation");

  const pending = await service.assess({
    trigger: "execution-checkpoint",
    subject: { kind: "Task", id: "task_context_001", revision: 1 },
    intent: "Continue and improve it as needed.",
  });
  assert.equal(pending.state, "awaiting-answers");
  const replacement = await service.assess({
    trigger: "execution-checkpoint",
    subject: { kind: "Task", id: "task_context_001", revision: 1 },
    intent: "Add one exact status field and verify its JSON value.",
  });
  assert.equal(replacement.state, "no-question-needed");
  assert.equal(service.get(pending.runId).state, "superseded");

  runtime.close();
  const cliAssessed = runCli(root, [
    "clarification", "assess",
    "--subject-kind", "Goal",
    "--subject-id", "goal_cli_001",
    "--intent", "Improve this goal as needed",
    "--trigger", "goal-review",
  ]);
  assert.equal(cliAssessed.state, "awaiting-answers");
  const cliRendered = invokeCli(root, [
    "clarification", "status",
    "--run", cliAssessed.runId as string,
    "--question-format", "chat",
  ]);
  assert.equal(cliRendered.status, 0, cliRendered.stderr);
  assert.match(cliRendered.stdout, /PKR Goal Clarification Sheet/);

  const reopened = await PkrRuntime.open(root, repositoryRoot);
  const recoveredService = new ClarificationService(reopened);
  const recovered = recoveredService.get(assessed.runId);
  assert.equal(recovered.state, "blocked");
  assert.equal(recovered.resolution?.action, "accept_recommended");

  const approved = await recoveredService.respond(assessed.runId, {
    action: "submit",
    answers: { "protected-decision": "approve" },
  });
  assert.equal(approved.state, "resolved");
  assert.deepEqual(approved.blockedActions, []);
  reopened.close();
});

test("CLI run creates a governed backlog Task card and preserves the approval gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "pkr-run-cli-"));
  temporaryRoots.push(root);
  await initializeGitRepository(root);
  runCli(root, ["init", "--name", "run-cli", "--outcome", "Run CLI requests through PKR."]);

  const ordinary = runCli(root, ["run", "--request", "Add a bounded local status command"]);
  assert.equal(ordinary.kind, "TaskCard");
  assert.equal(ordinary.goalId !== undefined, true);
  assert.equal(ordinary.taskId !== undefined, true);
  assert.equal(ordinary.phase, "backlog");
  assert.deepEqual(ordinary.next, {
    claim: "ready",
    submit: "after-claim",
    verify: "after-submit",
  });
  assert.equal("acceptance" in ordinary, false);
  const ordinaryStatus = runCli(root, ["status"]);
  assert.equal((ordinaryStatus.recordCounts as JsonObject).Goal, 1);
  assert.equal((ordinaryStatus.recordCounts as JsonObject).Task, 1);
  assert.equal((ordinaryStatus.recordCounts as JsonObject).Decision ?? 0, 0);
  assert.equal((ordinaryStatus.recordCounts as JsonObject).Verification ?? 0, 0);

  const material = runCliFailure(root, [
    "run",
    "--request",
    "Change the architecture and permission model for provider credentials",
  ]);
  assert.equal(material.code, "PKR-STEWARD-002");
  const renderedMaterial = invokeCli(root, [
    "steward", "propose",
    "--request", "Change the architecture and permission model for provider credentials",
    "--question-format", "cli",
  ]);
  assert.equal(renderedMaterial.status, 0, renderedMaterial.stderr);
  assert.match(renderedMaterial.stdout, /PKR Critical Fork Decision Sheet/);
  assert.match(renderedMaterial.stdout, /protected action remains blocked|跳过后仍阻塞/);
  const afterRejectedMaterial = runCli(root, ["status"]);
  assert.equal((afterRejectedMaterial.recordCounts as JsonObject).Goal, 1);
  assert.equal((afterRejectedMaterial.recordCounts as JsonObject).Task, 1);
  assert.equal((afterRejectedMaterial.recordCounts as JsonObject).Decision ?? 0, 0);

  const chineseMaterial = runCliFailure(root, [
    "run",
    "--request",
    "发布包含用户隐私和权限变更的兼容性方案",
  ]);
  assert.equal(chineseMaterial.code, "PKR-STEWARD-002");
  const approved = runCli(root, [
    "run",
    "--request",
    "发布包含用户隐私和权限变更的兼容性方案",
    "--approve-by",
    "human_001",
  ]);
  assert.equal(approved.phase, "backlog");
  assert.equal(approved.material, true);
  assert.equal(approved.approvedBy, "human_001");
  assert.equal(typeof approved.decisionId, "string");
  const finalStatus = runCli(root, ["status"]);
  assert.equal((finalStatus.recordCounts as JsonObject).Goal, 2);
  assert.equal((finalStatus.recordCounts as JsonObject).Task, 2);
  assert.equal((finalStatus.recordCounts as JsonObject).Decision, 1);
  assert.equal((finalStatus.recordCounts as JsonObject).Verification ?? 0, 0);
});

test("CLI run keeps empty, duplicate, and unknown option errors on the CLI contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "pkr-run-contract-"));
  temporaryRoots.push(root);
  await initializeGitRepository(root);
  runCli(root, ["init", "--name", "run-contract"]);

  const empty = invokeCli(root, ["run", "--request", ""]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /PKR-CLI-001/);
  const duplicate = invokeCli(root, ["run", "--request", "one", "--request", "two"]);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /duplicate option --request/);
  const unknown = invokeCli(root, ["run", "--wat", "value"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown option --wat/);
  const status = runCli(root, ["status"]);
  assert.equal((status.recordCounts as JsonObject).Goal ?? 0, 0);
  assert.equal((status.recordCounts as JsonObject).Task ?? 0, 0);
});

test("CLI diagnostic export is bounded, redacted, and side-effect free", async () => {
  const { root, runtime } = await project("diagnostic-export");
  const privateText = ["private", "diagnostic", "content"].join("-");
  const goal = await runtime.createGoal(privateText);
  const goalId = (((goal.value as JsonObject).metadata as JsonObject).id as string);
  const before = runtime.stateDigest();
  runtime.close();

  const diagnostics = runCli(root, ["diagnostics", "export"]);
  const encoded = JSON.stringify(diagnostics);
  assert.equal(diagnostics.version, "pkr.diagnostics/v1");
  assert.equal(encoded.includes(privateText), false);
  assert.equal(encoded.includes(goalId), false);
  assert.ok(Buffer.byteLength(encoded, "utf8") <= 64 * 1024);

  const reopened = await PkrRuntime.open(root, repositoryRoot);
  assert.equal(reopened.stateDigest(), before);
  reopened.close();
});

test("Agent-native LPS claims, submits real Git work, and waits for independent Verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "pkr-agent-native-cli-"));
  temporaryRoots.push(root);
  await initializeGitRepository(root);
  runCli(root, [
    "init",
    "--name",
    "agent-native-cli",
    "--outcome",
    "Complete one pull-mode Agent lane without a Provider process.",
  ]);
  await writeFile(
    join(root, ".pkr", "verification.json"),
    JSON.stringify(verificationPlan(["agent-native-result.txt"], true)),
    "utf8",
  );
  const doctor = invokeCli(root, ["doctor"]);
  assert.equal(doctor.status, 0, doctor.stderr);
  const doctorReport = JSON.parse(doctor.stdout) as JsonObject;
  assert.equal(doctorReport.ready, true);
  assert.equal((doctorReport.checks as JsonObject[]).some((check) => check.id === "provider-config"), false);
  assert.equal(preflightCheck(doctorReport, "agent-native").status, "pass");

  const intake = runCli(root, [
    "steward",
    "apply",
    "--request",
    "Produce one Agent-native repository result",
  ]);
  const agent = runCli(root, [
    "agent",
    "register",
    "--name",
    "current-agent",
    "--host",
    "agent-host",
  ]);
  const agentId = (((agent.value as JsonObject).metadata as JsonObject).id as string);
  const claim = runCli(root, [
    "lps",
    "claim",
    "--task",
    intake.taskId as string,
    "--agent",
    agentId,
    "--session-locator",
    "agent-host://session/agent-native-test",
  ]);
  assert.equal(((claim.workspace as JsonObject).kind as string), "Workspace");
  assert.equal(((claim.board as JsonObject).source as JsonObject).authority, "PKR");
  const reusedClaim = runCli(root, [
    "lps",
    "claim",
    "--task",
    intake.taskId as string,
    "--agent",
    agentId,
    "--session-locator",
    "agent-host://session/ignored-on-reuse",
  ]);
  assert.equal(reusedClaim.reused, true);
  assert.equal(reusedClaim.assignmentId, claim.assignmentId);
  assert.equal(reusedClaim.sessionId, claim.sessionId);
  assert.equal(reusedClaim.leaseId, claim.leaseId);

  const claimedRuntime = await PkrRuntime.open(root, repositoryRoot);
  const session = claimedRuntime.getRecord("AgentSession", claim.sessionId as string);
  const lease = claimedRuntime.getRecord("Lease", claim.leaseId as string);
  const capability = claimedRuntime.getRecord(
    "CapabilityStatement",
    session.data.capabilityStatementId as string,
  );
  const nativeSession = (session.data.extensions as JsonObject)["pkr.agent-native/session"] as JsonObject;
  assert.equal(session.data.sessionLocator, "agent-host://session/agent-native-test");
  assert.equal(nativeSession.locatorIsIdentity, false);
  assert.equal(nativeSession.locatorIsAuthority, false);
  assert.equal(lease.data.agentId, agentId);
  assert.equal((capability.data.adapter as JsonObject).id, "pkr.agent-native");
  assert.equal(claimedRuntime.listRecords("Assignment").length, 1);
  claimedRuntime.close();

  await writeFile(join(root, "agent-native-result.txt"), "work produced by the loaded Agent\n", "utf8");
  const submission = runCli(root, [
    "lps",
    "submit",
    "--assignment",
    claim.assignmentId as string,
    "--agent",
    agentId,
    "--result",
    JSON.stringify({
      outcome: "partial",
      completed: ["repository-change-produced"],
      incomplete: ["independent-verification", "acceptance"],
      blockers: [],
      evidenceIds: [],
      outputs: [{ kind: "patch", locator: "agent-native-result.txt" }],
      nextAction: "Run independent repository Verification.",
    }),
  ]);
  assert.equal(submission.outcome, "partial");
  assert.equal(((submission.repository as JsonObject).changedFiles as string[]).includes("agent-native-result.txt"), true);
  const afterSubmit = runCli(root, ["status"]);
  assert.equal((afterSubmit.recordCounts as JsonObject).Verification ?? 0, 0);
  const submittedRuntime = await PkrRuntime.open(root, repositoryRoot);
  assert.equal(
    (submittedRuntime.getRecord("Task", intake.taskId as string).data.status as JsonObject).phase,
    "verifying",
  );
  const message = submittedRuntime.listRecords("AgentMessage")[0]!;
  const workspaceEvidence = (message.data.extensions as JsonObject)["pkr.workspace/evidence"] as JsonObject;
  assert.equal(
    (((workspaceEvidence.current as JsonObject).changedFiles as string[]).includes("agent-native-result.txt")),
    true,
  );
  submittedRuntime.close();

  const reusedSubmission = runCli(root, [
    "lps",
    "submit",
    "--assignment",
    claim.assignmentId as string,
    "--agent",
    agentId,
  ]);
  assert.equal(reusedSubmission.reused, true);
  assert.equal((runCli(root, ["status"]).recordCounts as JsonObject).Verification ?? 0, 0);

  const verification = runCli(root, [
    "verify",
    "--task",
    intake.taskId as string,
    "--assignment",
    claim.assignmentId as string,
  ]);
  assert.equal((verification.value as JsonObject).passed, true);
  const board = runCli(root, ["lps", "board"]);
  assert.equal(((board.workers as JsonObject[])[0]?.state as string), "archived");
  const finalStatus = runCli(root, ["status"]);
  assert.equal((finalStatus.recordCounts as JsonObject).Verification, 2);

  const reopened = await PkrRuntime.open(root, repositoryRoot);
  assert.deepEqual(new LpsOrchestrator(reopened).board(), board);
  assert.equal((reopened.getRecord("Task", intake.taskId as string).data.status as JsonObject).phase, "done");
  reopened.close();
});

test("LPS exercises a real process boundary with a fake Provider fixture and rebuilds its board", async () => {
  const { root, runtime } = await project("lps-process");
  const steward = new StewardService(runtime);
  const intake = await steward.apply(
    steward.prepare("Implement one fake Provider fixture golden path"),
  );
  const agentResult = await runtime.registerAgent("process-worker", "local-process");
  const agentId = (((agentResult.value as JsonObject).metadata as JsonObject).id as string);
  const provider = new LocalProcessAdapter(process.execPath, workerScript, 10_000, {
    PKR_PROVIDER_WRITE_FILE: "provider-result.txt",
  });
  const lps = new LpsOrchestrator(runtime, provider);
  const before = runtime.listEvents().length;
  const result = await lps.executeLane(intake.taskId as string, agentId);
  assert.equal(result.callback?.outcome, "partial");
  assert.equal(result.process?.exitCode, 0);
  assert.equal(result.process?.timedOut, false);
  assert.equal(result.process?.stderr, "");
  assert.equal(
    (runtime.getRecord("Task", intake.taskId as string).data.status as JsonObject).phase,
    "verifying",
  );
  assert.equal(runtime.getRecord("AgentSession", result.sessionId).data.state, "closing");
  assert.equal(runtime.listRecords("Verification").length, 0);
  const providerMessage = runtime.listRecords("AgentMessage").find(
    (record) => record.data.assignmentId === result.assignmentId,
  );
  assert.ok(providerMessage);
  const providerProcess = (providerMessage.data.extensions as JsonObject)["pkr.provider/process"] as JsonObject;
  const repositoryEvidence = (providerMessage.data.extensions as JsonObject)["pkr.workspace/evidence"] as JsonObject;
  assert.equal(providerProcess.exitCode, 0);
  assert.equal(providerProcess.stdout, "[OMITTED: parsed structured output]");
  assert.equal(providerProcess.cwd, "[PROJECT-ROOT]");
  assert.deepEqual(
    (((repositoryEvidence.baseline as JsonObject).changedFiles as string[]) ?? []),
    [],
  );
  assert.equal(
    ((repositoryEvidence.current as JsonObject).changedFiles as string[]).includes("provider-result.txt"),
    true,
  );
  const verificationEvidence = await runLocalVerification(
    root,
    intake.taskId as string,
    result.assignmentId,
    verificationPlan(["provider-result.txt"], true),
  );
  const accepted = await runtime.verify(
    intake.taskId as string,
    result.assignmentId,
    "agent_repository_verifier",
    "command_repository_verify",
    verificationEvidence,
  );
  assert.equal((accepted.value as JsonObject).passed, true);
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
  const timeoutResult = await slowLps.executeLane(timeout.taskId as string, agentId);
  assert.equal(timeoutResult.callback, undefined);
  assert.equal(timeoutResult.process?.timedOut, true);
  assert.equal(timeoutResult.process?.failureReason, "TimedOut");
  const timedOutAssignment = runtime
    .listRecords("Assignment")
    .find((record) => record.data.taskId === timeout.taskId)!;
  assert.equal(timedOutAssignment.data.state, "failed");
  assert.equal(
    (runtime.getRecord("Task", timeout.taskId as string).data.status as JsonObject).phase,
    "blocked",
  );
  const failureMessage = runtime.listRecords("AgentMessage").find(
    (record) => record.data.assignmentId === timedOutAssignment.id,
  );
  const processEvidence = (failureMessage?.data.extensions as JsonObject)["pkr.provider/process"] as JsonObject;
  assert.equal(processEvidence.timedOut, true);
  assert.equal(processEvidence.failureReason, "TimedOut");

  const nonZero = await steward.apply(steward.prepare("Test provider non-zero exit"));
  const failedLps = new LpsOrchestrator(
    runtime,
    new LocalProcessAdapter(process.execPath, [
      "-e",
      "process.stderr.write('provider failed'); process.exit(7)",
    ]),
  );
  const failedResult = await failedLps.executeLane(nonZero.taskId as string, agentId);
  assert.equal(failedResult.callback, undefined);
  assert.equal(failedResult.process?.exitCode, 7);
  assert.equal(failedResult.process?.stderr, "provider failed");
  assert.equal(failedResult.process?.failureReason, "ExitCode:7");
  const failedAssignment = runtime
    .listRecords("Assignment")
    .find((record) => record.data.taskId === nonZero.taskId)!;
  assert.equal(failedAssignment.data.state, "failed");
  assert.equal(
    (runtime.getRecord("Task", nonZero.taskId as string).data.status as JsonObject).phase,
    "blocked",
  );
  runtime.close();
});

test("repository-native CLI harness closes from configured fake stdio Provider through restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pkr-orchestration-cli-"));
  temporaryRoots.push(root);
  await initializeGitRepository(root);
  await writeFile(
    join(root, "provider.mjs"),
    `import { mkdirSync, writeFileSync } from "node:fs";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (!request.assignmentId || !request.sessionId || request.workspace?.kind !== "Workspace") {
    throw new Error("invalid PKR Provider request");
  }
  mkdirSync("src", { recursive: true });
  writeFileSync("src/provider-result.txt", "result " + request.assignmentId + "\\n", "utf8");
  process.stdout.write(JSON.stringify({
    outcome: "partial",
    completed: ["repository-change-produced"],
    incomplete: ["repository-verification", "acceptance"],
    blockers: [],
    evidenceIds: [],
    outputs: [{ kind: "patch", locator: "src/provider-result.txt" }],
    nextAction: "run the independent repository Verifier"
  }));
});
`,
    "utf8",
  );
  assert.equal(spawnSync("git", ["add", "provider.mjs"], { cwd: root }).status, 0);
  const providerCommit = spawnSync(
    "git",
    [
      "-c", "user.name=PKR Test",
      "-c", "user.email=pkr@example.invalid",
      "commit", "-m", "add repository provider",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(providerCommit.status, 0, providerCommit.stderr);

  const uninitializedDoctor = invokeCli(root, ["doctor"]);
  assert.equal(uninitializedDoctor.status, 2, uninitializedDoctor.stderr);
  const uninitializedReport = JSON.parse(uninitializedDoctor.stdout) as JsonObject;
  assert.equal(uninitializedReport.ready, false);
  assert.equal(preflightCheck(uninitializedReport, "git").status, "pass");
  assert.equal(preflightCheck(uninitializedReport, "runtime").code, "PKR-RUNTIME-007");
  assert.equal((uninitializedReport.checks as JsonObject[]).some((check) => check.id === "provider-config"), false);
  assert.equal(preflightCheck(uninitializedReport, "agent-native").status, "blocked");
  assert.equal(preflightCheck(uninitializedReport, "verification-config").code, "PKR-VERIFY-001");

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
    "--host",
    "local-process-adapter",
  ]);
  const agentId = (((agent.value as JsonObject).metadata as JsonObject).id as string);

  const beforeMissingDoctor = runCli(root, ["digest"]);
  const missingDoctor = invokeCli(root, ["doctor"]);
  assert.equal(missingDoctor.status, 2, missingDoctor.stderr);
  const missingReport = JSON.parse(missingDoctor.stdout) as JsonObject;
  assert.equal(missingReport.ready, false);
  assert.equal(preflightCheck(missingReport, "runtime").status, "pass");
  assert.equal(preflightCheck(missingReport, "agent-native").status, "pass");
  assert.equal((missingReport.checks as JsonObject[]).some((check) => check.id === "provider-config"), false);
  assert.equal(runCli(root, ["digest"]).digest, beforeMissingDoctor.digest);

  const missingConfig = runCliFailure(root, [
    "lps",
    "adapter-run",
    "--task",
    intake.taskId as string,
    "--agent",
    agentId,
  ]);
  assert.equal(missingConfig.code, "PKR-PROVIDER-001");
  assert.equal((runCli(root, ["status"]).recordCounts as JsonObject).Assignment ?? 0, 0);

  const providerPath = join(root, ".pkr", "provider.json");
  await writeFile(
    join(root, ".pkr", "verification.json"),
    JSON.stringify(verificationPlan(["src/**"], true)),
    "utf8",
  );
  await writeFile(
    providerPath,
    JSON.stringify(localProviderConfig(process.execPath, "pkr.adapter.not-registered")),
    "utf8",
  );
  const missingBindingDoctor = invokeCli(root, ["doctor", "--adapter"]);
  assert.equal(missingBindingDoctor.status, 2, missingBindingDoctor.stderr);
  const missingBindingReport = JSON.parse(missingBindingDoctor.stdout) as JsonObject;
  assert.equal(preflightCheck(missingBindingReport, "provider-config").status, "pass");
  assert.equal(preflightCheck(missingBindingReport, "provider-executable").status, "pass");
  assert.equal(preflightCheck(missingBindingReport, "verification-config").status, "pass");
  assert.equal(preflightCheck(missingBindingReport, "adapter-binding").code, "PKR-EVOLUTION-012");
  const missingBinding = runCliFailure(root, [
    "lps",
    "adapter-run",
    "--task",
    intake.taskId as string,
    "--agent",
    agentId,
  ]);
  assert.equal(missingBinding.code, "PKR-EVOLUTION-012");
  assert.equal((runCli(root, ["status"]).recordCounts as JsonObject).Assignment ?? 0, 0);

  await writeFile(
    providerPath,
    JSON.stringify(localProviderConfig(process.execPath)),
    "utf8",
  );
  const beforeReadyDoctor = runCli(root, ["digest"]);
  const readyDoctor = invokeCli(root, ["doctor", "--adapter"]);
  assert.equal(readyDoctor.status, 0, readyDoctor.stderr);
  const readyReport = JSON.parse(readyDoctor.stdout) as JsonObject;
  assert.equal(readyReport.ready, true);
  assert.equal((readyReport.checks as JsonObject[]).every((check) => check.status === "pass"), true);
  assert.equal(runCli(root, ["digest"]).digest, beforeReadyDoctor.digest);
  assert.equal(existsSync(join(root, "src", "provider-result.txt")), false);
  const execution = runCli(root, [
    "lps",
    "adapter-run",
    "--task",
    intake.taskId as string,
    "--agent",
    agentId,
  ]);
  assert.equal((execution.callback as JsonObject).outcome, "partial");
  assert.equal((execution.process as JsonObject).exitCode, 0);
  assert.equal(
    await readFile(join(root, "src", "provider-result.txt"), "utf8"),
    `result ${execution.assignmentId as string}\n`,
  );
  const beforeVerification = runCli(root, ["status"]);
  assert.equal((beforeVerification.recordCounts as JsonObject).Verification ?? 0, 0);
  const verification = runCli(root, [
    "verify",
    "--task",
    intake.taskId as string,
    "--assignment",
    execution.assignmentId as string,
  ]);
  assert.equal((verification.value as JsonObject).passed, true);
  const board = runCli(root, ["lps", "board"]);
  assert.equal((board.source as JsonObject).authority, "PKR");
  assert.equal(((board.workers as JsonObject[])[0]?.state as string), "archived");
  const beforeRebuild = runCli(root, ["digest"]);
  runCli(root, ["projection", "rebuild"]);
  const afterRebuild = runCli(root, ["digest"]);
  assert.equal(afterRebuild.digest, beforeRebuild.digest);
  const finalStatus = runCli(root, ["status"]);
  assert.equal((finalStatus.recordCounts as JsonObject).Verification, 2);
});
