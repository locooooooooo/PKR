import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { PkrError } from "./errors.js";
import {
  bootstrapProject,
  prepareProjectIntake,
  resolveProjectIntake,
  writeProjectPlanProjection,
  type ProjectBootstrapProposal,
  type ProjectIntakeReady,
  type ProjectPlanProjection,
} from "./project-manager.js";
import { PkrRuntime } from "./runtime.js";
import {
  CHAT_MARKDOWN_PROFILE,
  CLI_COMPACT_PROFILE,
  renderQuestionSheet,
} from "./question-sheet-renderer.js";
import type { JsonObject } from "./types.js";
import { loadVerificationPlan, runLocalVerification, type VerificationPlan } from "./verifier.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repositoryRoot, "dist", "cli.js");
const temporaryRoots: string[] = [];

async function temporaryParent(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pkr-project-${name}-`));
  temporaryRoots.push(root);
  return root;
}

function proposalFor(targetRoot: string): ProjectBootstrapProposal {
  const intake = prepareProjectIntake({
    request: "Build a playable interactive movie editor.",
    projectName: "story-editor",
    title: "Story Editor",
    outcome: "Deliver a playable editor vertical slice with independently verified repository evidence.",
    audience: "independent narrative game creators",
    targetRoot,
    horizonMonths: 3,
    dailyPlanDays: 7,
  });
  assert.equal(intake.state, "awaiting_approval");
  return (intake as ProjectIntakeReady).proposal;
}

function runCli(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: "utf8" });
}

function objectId(value: JsonObject | undefined): string {
  assert.ok(value);
  return ((value.metadata as JsonObject).id as string);
}

afterEach(async () => {
  delete process.env.PKR_PROJECT_MANAGER_FAILPOINT;
  while (temporaryRoots.length) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

test("project intake asks structured questions and approval failures create no project", async () => {
  const parent = await temporaryParent("clarify");
  const target = join(parent, "story-editor");
  const cli = runCli(["project", "intake", "--request", "Build a playable editor"], parent);
  assert.equal(cli.status, 0, cli.stderr);
  const clarification = JSON.parse(cli.stdout) as JsonObject;
  assert.equal(clarification.state, "clarification_required");
  assert.deepEqual(
    (clarification.questions as JsonObject[]).map((question) => question.id),
    ["request", "projectName", "outcome", "audience", "targetRoot", "horizonMonths", "dailyPlanDays"],
  );
  assert.equal((clarification.questionSheet as JsonObject).kind, "QuestionSheet");
  assert.equal(((clarification.questionSheet as JsonObject).behavior as JsonObject).sheetSkippable, true);
  assert.equal(((clarification.questionSheet as JsonObject).behavior as JsonObject).recommendationsPreselected, true);
  assert.deepEqual(clarification.clarification, {
    state: "awaiting-answers",
    persistence: "pre-runtime",
    trigger: "project-intake",
    questionSheetId: (clarification.questionSheet as JsonObject).sheetId,
  });
  assert.equal(
    (clarification.questions as JsonObject[]).every((question) => question.required === false),
    true,
  );
  const prepared = prepareProjectIntake({ request: "Build a playable editor" });
  assert.equal(prepared.state, "clarification_required");
  const renderedSheet = prepared.state === "clarification_required" ? prepared.questionSheet : undefined;
  assert.ok(renderedSheet);
  const chatRender = renderQuestionSheet(renderedSheet, CHAT_MARKDOWN_PROFILE);
  assert.match(chatRender.text, /^# PKR Project Start Sheet/m);
  assert.match(chatRender.text, /选择题/);
  assert.match(chatRender.text, /accept_recommended/);
  const cliRender = renderQuestionSheet(renderedSheet, CLI_COMPACT_PROFILE);
  assert.match(cliRender.text, /PKR Project Start Sheet/);
  assert.match(cliRender.text, /答案: JSON object keyed by question id/);
  assert.throws(
    () => renderQuestionSheet({ ...renderedSheet, title: "Tampered sheet" }, CHAT_MARKDOWN_PROFILE),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-QUESTION-001",
  );
  assert.equal(existsSync(target), false);

  const partialInput = {
    request: "Build a playable editor",
    targetRoot: target,
  };
  const sheetIntake = prepareProjectIntake(partialInput);
  assert.equal(sheetIntake.state, "clarification_required");
  const sheet = sheetIntake.state === "clarification_required" ? sheetIntake.questionSheet : undefined;
  assert.ok(sheet);
  const skipped = resolveProjectIntake(partialInput, { action: "skip", answers: {} });
  assert.equal(skipped.state, "awaiting_approval");
  assert.equal(skipped.proposal.targetRoot, resolve(target));
  assert.equal(skipped.proposal.horizonMonths, 3);
  assert.equal(skipped.proposal.rollingDailyPlan.length, 7);
  assert.ok(skipped.proposal.questionnaire);
  assert.equal(skipped.proposal.questionnaire.source, "question_sheet");
  assert.equal(skipped.proposal.questionnaire.sheetId, sheet.sheetId);
  assert.equal(skipped.proposal.questionnaire.sheetDigest, sheet.digest);
  assert.equal(skipped.proposal.questionnaire.action, "skip");
  assert.equal(typeof skipped.proposal.questionnaire.resolutionDigest, "string");
  assert.equal(existsSync(target), false);

  const skippedCli = runCli([
    "project", "intake",
    "--request", "Build a playable editor",
    "--target", target,
    "--skip-questions",
  ], parent);
  assert.equal(skippedCli.status, 0, skippedCli.stderr);
  const skippedCliResult = JSON.parse(skippedCli.stdout) as JsonObject;
  assert.equal(skippedCliResult.state, "awaiting_approval");
  assert.equal(((skippedCliResult.proposal as JsonObject).questionnaire as JsonObject).action, "skip");
  assert.equal(existsSync(target), false);

  const chatCli = runCli([
    "project", "intake",
    "--request", "Build a playable editor",
    "--question-format", "chat",
  ], parent);
  assert.equal(chatCli.status, 0, chatCli.stderr);
  assert.match(chatCli.stdout, /^# PKR Project Start Sheet/m);
  assert.equal(chatCli.stdout.trimStart().startsWith("{"), false);

  const answersPath = join(parent, "answers.json");
  await writeFile(answersPath, JSON.stringify({
    projectName: "answered-editor",
    outcome: "Deliver an answered intake proposal.",
    audience: "pilot editors",
    horizonMonths: 1,
    dailyPlanDays: 3,
  }), "utf8");
  const answeredCli = runCli([
    "project", "intake",
    "--request", "Build a playable editor",
    "--target", target,
    "--answers-file", answersPath,
  ], parent);
  assert.equal(answeredCli.status, 0, answeredCli.stderr);
  const answeredCliResult = JSON.parse(answeredCli.stdout) as JsonObject;
  const answeredProposal = answeredCliResult.proposal as JsonObject;
  assert.equal(answeredProposal.projectName, "answered-editor");
  assert.equal(answeredProposal.horizonMonths, 1);
  assert.equal((answeredProposal.monthlyMilestones as JsonObject[]).length, 1);
  assert.equal(((answeredProposal.questionnaire as JsonObject).action), "submit");
  assert.equal(existsSync(target), false);

  const proposal = proposalFor(target);
  await assert.rejects(
    bootstrapProject({ ...proposal, outcome: "Tampered outcome" }, "human_owner", repositoryRoot),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-PROJECT-002",
  );
  await assert.rejects(
    bootstrapProject(proposal, undefined, repositoryRoot),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-PROJECT-004",
  );
  await assert.rejects(
    bootstrapProject(proposal, "agent_builder", repositoryRoot),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-PROJECT-004",
  );
  assert.equal(existsSync(target), false);

  await mkdir(target);
  await writeFile(join(target, "keep.txt"), "user-owned\n", "utf8");
  await assert.rejects(
    bootstrapProject(proposal, "human_owner", repositoryRoot),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-PROJECT-005",
  );
  assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "user-owned\n");
});

test("approved CLI bootstrap creates Git and PKR truth without acceptance", async () => {
  const parent = await temporaryParent("bootstrap");
  const target = join(parent, "story-editor");
  const proposalPath = join(parent, "proposal.json");
  await writeFile(proposalPath, `\uFEFF${JSON.stringify(proposalFor(target), null, 2)}\n`, "utf8");

  const bootstrap = runCli([
    "project", "bootstrap",
    "--proposal-file", proposalPath,
    "--approve-by", "human_owner",
  ], parent);
  assert.equal(bootstrap.status, 0, bootstrap.stderr || bootstrap.stdout);
  const result = JSON.parse(bootstrap.stdout) as JsonObject;
  assert.equal(result.state, "initialized_claim_ready");
  assert.equal((result.readiness as JsonObject).ready, false);
  assert.equal((result.readiness as JsonObject).claimReady, true);
  assert.equal((result.readiness as JsonObject).verificationReady, false);
  assert.equal(existsSync(join(target, ".git")), true);
  assert.equal(existsSync(join(target, ".pkr", "runtime.sqlite")), true);
  assert.equal(existsSync(join(target, ".pkr", "projections", "project-manager", "plan.json")), true);

  const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: target, encoding: "utf8" });
  assert.equal(head.status, 0, head.stderr);
  assert.match(head.stdout.trim(), /^[0-9a-f]{40}$/);
  const gitStatus = spawnSync("git", ["status", "--short"], { cwd: target, encoding: "utf8" });
  assert.equal(gitStatus.status, 0, gitStatus.stderr);
  assert.equal(gitStatus.stdout, "");

  const runtime = await PkrRuntime.open(target, repositoryRoot);
  assert.equal(runtime.ownerId(), "human_owner");
  assert.equal(runtime.listRecords("Mission").length, 1);
  assert.equal(runtime.listRecords("Goal").length, 1);
  assert.equal(runtime.listRecords("Task").length, 10);
  assert.equal(runtime.listRecords("Decision").length, 1);
  assert.equal(runtime.listRecords("Verification").length, 0);
  for (const task of runtime.listRecords("Task")) {
    const provenance = (task.data.extensions as JsonObject)["pkr.project-manager/plan"] as JsonObject;
    assert.equal(provenance.apiVersion, "pkr.project-plan/v1");
    assert.equal(typeof provenance.digest, "string");
    assert.equal(provenance.goalId, (result.goalId as string));
  }
  const plan = await writeProjectPlanProjection(runtime);
  assert.equal(plan.source.authority, "PKR");
  assert.equal(plan.source.stateDigest, runtime.stateDigest());
  assert.equal(plan.monthlyMilestones.length, 3);
  assert.equal(plan.rollingDailyPlan.length, 7);
  assert.equal(plan.verification.status, "unconfigured");
  assert.equal(plan.readiness.ready, false);
  assert.equal(plan.readiness.claimReady, true);
  assert.equal(plan.readiness.verificationReady, false);
  assert.equal(plan.readiness.blockers.some((blocker) => blocker.id === "provider-config"), false);
  assert.equal(plan.readiness.blockers.some((blocker) => blocker.id === "verification-config"), true);
  runtime.close();

  const doctor = runCli(["doctor", "--project", target], parent);
  assert.equal(doctor.status, 2, doctor.stderr);
  const doctorPayload = JSON.parse(doctor.stdout) as JsonObject;
  assert.equal(doctorPayload.ready, false);
  const doctorChecks = doctorPayload.checks as JsonObject[];
  assert.equal(doctorChecks.some((check) => check.id === "provider-config"), false);
  assert.equal(doctorChecks.find((check) => check.id === "agent-native")?.status, "pass");
  assert.equal(doctorChecks.find((check) => check.id === "verification-config")?.status, "fail");
  const adapterDoctor = runCli(["doctor", "--adapter", "--project", target], parent);
  assert.equal(adapterDoctor.status, 2, adapterDoctor.stderr);
  const adapterChecks = (JSON.parse(adapterDoctor.stdout) as JsonObject).checks as JsonObject[];
  assert.equal(adapterChecks.find((check) => check.id === "provider-config")?.status, "fail");
  const firstTaskId = ((result.monthlyTasks as JsonObject[])[0]!.taskId as string);
  const lps = runCli([
    "lps", "adapter-run", "--project", target, "--task", firstTaskId, "--agent", "agent_not_registered",
  ], parent);
  assert.equal(lps.status, 1, lps.stdout);
  const lpsError = JSON.parse(lps.stderr.trim().split(/\r?\n/).at(-1)!) as JsonObject;
  assert.equal(lpsError.code, "PKR-PROVIDER-001");

  const status = runCli(["project", "status", "--project", target], parent);
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout) as JsonObject;
  assert.equal(statusPayload.state, "initialized_claim_ready");
  assert.equal(((statusPayload.plan as JsonObject).source as JsonObject).authority, "PKR");
});

test("default Verification fails closed on a clean repository and creates no acceptance", async () => {
  const parent = await temporaryParent("fail-closed");
  const target = join(parent, "fail-closed-project");
  await bootstrapProject(proposalFor(target), "human_owner", repositoryRoot);

  const runtime = await PkrRuntime.open(target, repositoryRoot);
  const taskId = runtime.listRecords("Task")[0]!.id;
  const agent = await runtime.registerAgent("default-verification-worker", "local");
  const agentId = objectId(agent.value);
  const dispatch = await runtime.dispatch(taskId, agentId);
  const assignmentId = (dispatch.value as JsonObject).assignmentId as string;
  await runtime.callback(assignmentId, "partial", []);
  const plan = await loadVerificationPlan(join(target, ".pkr", "verification.json"));
  assert.equal(plan.mode, "unconfigured");
  const evidence = await runLocalVerification(target, taskId, assignmentId, plan);
  assert.equal(evidence.passed, false);
  assert.deepEqual(((evidence.repository as JsonObject).changedFiles as string[]), []);

  const verification = await runtime.verify(
    taskId,
    assignmentId,
    "agent_independent_verifier",
    "command_default_verification_must_fail",
    evidence,
  );
  assert.equal((verification.value as JsonObject).passed, false);
  assert.equal(runtime.listRecords("Verification").length, 1);
  assert.equal(
    runtime.listRecords("Verification").filter((record) =>
      (record.data.spec as JsonObject).gate === "acceptance" &&
      (record.data.status as JsonObject).phase === "passed"
    ).length,
    0,
  );
  assert.equal((runtime.getRecord("Task", taskId).data.status as JsonObject).phase, "blocked");
  const projection = await writeProjectPlanProjection(runtime);
  assert.equal(projection.verification.status, "unconfigured");
  assert.equal(projection.verification.recordedVerificationCount, 1);
  assert.equal(projection.verification.passedAcceptanceCount, 0);
  runtime.close();
});

test("unrelated title and Verification do not contaminate the structured project plan", async () => {
  const parent = await temporaryParent("provenance");
  const target = join(parent, "provenance-project");
  await bootstrapProject(proposalFor(target), "human_owner", repositoryRoot);

  const runtime = await PkrRuntime.open(target, repositoryRoot);
  const initial = await writeProjectPlanProjection(runtime);
  const unrelatedGoal = await runtime.createGoal("Maintain an unrelated subsystem");
  const unrelatedGoalId = objectId(unrelatedGoal.value);
  const unrelatedTask = await runtime.createTask(
    unrelatedGoalId,
    "Month 4 milestone: unrelated maintenance",
  );
  const unrelatedTaskId = objectId(unrelatedTask.value);
  const agent = await runtime.registerAgent("unrelated-worker", "local");
  const agentId = objectId(agent.value);
  const dispatch = await runtime.dispatch(unrelatedTaskId, agentId);
  const assignmentId = (dispatch.value as JsonObject).assignmentId as string;
  await writeFile(join(target, "unrelated.txt"), "verified unrelated work\n", "utf8");
  await runtime.callback(assignmentId, "partial", []);
  const unrelatedPlan: VerificationPlan = {
    version: "pkr.verify/v1",
    mode: "configured",
    commands: [{
      id: "unrelated-check",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 10_000,
    }],
    allowedPaths: ["unrelated.txt"],
    forbiddenPaths: [".pkr/**"],
    requireChanges: true,
  };
  const evidence = await runLocalVerification(target, unrelatedTaskId, assignmentId, unrelatedPlan);
  assert.equal(evidence.passed, true);
  await runtime.verify(
    unrelatedTaskId,
    assignmentId,
    "agent_independent_verifier",
    "command_verify_unrelated_task",
    evidence,
  );
  assert.equal(runtime.listRecords("Verification").length, 2);

  const rebuilt = await writeProjectPlanProjection(runtime);
  assert.deepEqual(rebuilt.monthlyMilestones.map((item) => item.taskId), initial.monthlyMilestones.map((item) => item.taskId));
  assert.deepEqual(rebuilt.rollingDailyPlan.map((item) => item.taskId), initial.rollingDailyPlan.map((item) => item.taskId));
  assert.equal(rebuilt.verification.recordedVerificationCount, 0);
  assert.equal(rebuilt.verification.passedAcceptanceCount, 0);
  assert.equal(rebuilt.verification.status, "unconfigured");
  runtime.close();
});

test("legacy title-only plans fail with an explicit migration error", async () => {
  const root = await temporaryParent("legacy");
  const runtime = await PkrRuntime.init(root, repositoryRoot, {
    name: "legacy-plan",
    title: "Legacy Plan",
    outcome: "Expose a deterministic migration boundary.",
  });
  const goal = await runtime.createGoal("Legacy manager goal");
  await runtime.createTask(objectId(goal.value), "Month 1 milestone: legacy title only");
  await assert.rejects(
    writeProjectPlanProjection(runtime),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-PROJECT-007",
  );
  runtime.close();
});

test("bootstrap failure removes the target directory it created", async () => {
  const parent = await temporaryParent("rollback");
  const target = join(parent, "failed-project");
  process.env.PKR_PROJECT_MANAGER_FAILPOINT = "after-runtime-init";
  await assert.rejects(
    bootstrapProject(proposalFor(target), "human_owner", repositoryRoot),
    /failpoint after-runtime-init/,
  );
  assert.equal(existsSync(target), false);
});

test("monthly and rolling plans rebuild after restart from SQLite authority", async () => {
  const parent = await temporaryParent("recover");
  const target = join(parent, "recover-project");
  await bootstrapProject(proposalFor(target), "human_owner", repositoryRoot);

  const runtime = await PkrRuntime.open(target, repositoryRoot);
  const initial = await writeProjectPlanProjection(runtime);
  const initialTaskIds = [
    ...initial.monthlyMilestones.map((item) => item.taskId),
    ...initial.rollingDailyPlan.map((item) => item.taskId),
  ];
  await runtime.rebuildProjections();
  const cachedPath = join(target, ".pkr", "projections", "project-manager", "plan.json");
  assert.equal(existsSync(cachedPath), false);
  runtime.close();

  const reopened = await PkrRuntime.open(target, repositoryRoot);
  const rebuilt = await writeProjectPlanProjection(reopened);
  assert.deepEqual(
    [...rebuilt.monthlyMilestones.map((item) => item.taskId), ...rebuilt.rollingDailyPlan.map((item) => item.taskId)],
    initialTaskIds,
  );
  assert.equal(rebuilt.source.authority, "PKR");
  assert.equal(rebuilt.source.stateDigest, reopened.stateDigest());
  assert.equal(reopened.listRecords("Verification").length, 0);
  reopened.close();

  const cached = JSON.parse(await readFile(cachedPath, "utf8")) as ProjectPlanProjection;
  assert.equal(cached.digest, rebuilt.digest);
});
