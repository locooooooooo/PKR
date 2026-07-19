import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { PkrError } from "./errors.js";
import { PkrRuntime } from "./runtime.js";
import { PkrStore } from "./store.js";
import type { JsonObject } from "./types.js";
import { derivedId, digest } from "./util.js";
import { runLocalVerification, type VerificationPlan } from "./verifier.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pkr-runtime-"));
  temporaryRoots.push(root);
  const init = spawnSync("git", ["init", "-b", "main"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  await writeFile(join(root, ".gitignore"), ".pkr/\n", "utf8");
  await writeFile(join(root, "README.md"), "# Runtime test repository\n", "utf8");
  assert.equal(spawnSync("git", ["add", "."], { cwd: root }).status, 0);
  const commit = spawnSync(
    "git",
    ["-c", "user.name=PKR Test", "-c", "user.email=pkr@example.invalid", "commit", "-m", "baseline"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(commit.status, 0, commit.stderr);
  return root;
}

function verificationPlan(allowedPaths: string[], requireChanges = true): VerificationPlan {
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

afterEach(async () => {
  while (temporaryRoots.length) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function value(result: { value?: JsonObject }): JsonObject {
  assert.ok(result.value, "committed result must include a value");
  return result.value;
}

function objectId(object: JsonObject): string {
  return ((object.metadata as JsonObject).id as string);
}

function runCli(projectRoot: string, args: string[]): JsonObject {
  const cli = resolve(repositoryRoot, "dist", "cli.js");
  const result = spawnSync(
    process.execPath,
    [cli, ...args, "--project", projectRoot],
    { encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `CLI failed: ${result.stderr || result.stdout}`,
  );
  return JSON.parse(result.stdout) as JsonObject;
}

test("bootstrap is atomic and restart reconstructs identical state", async () => {
  const projectRoot = await temporaryProject();
  const runtime = await PkrRuntime.init(projectRoot, repositoryRoot, {
    name: "runtime-test",
    title: "Runtime Test",
    outcome: "Prove atomic local PKR runtime behavior.",
  });
  const initialDigest = runtime.stateDigest();
  assert.equal(runtime.listEvents().length, 8);
  assert.equal(runtime.status().projectSequence, 8);
  runtime.close();

  const reopened = await PkrRuntime.open(projectRoot, repositoryRoot);
  assert.equal(reopened.stateDigest(), initialDigest);
  assert.equal(reopened.listEvents().at(-1)?.type, "pkr.project.bootstrapped");
  reopened.close();
});

test("local golden path reaches done only after independent repository evidence", async () => {
  const projectRoot = await temporaryProject();
  const runtime = await PkrRuntime.init(projectRoot, repositoryRoot, {
    name: "golden-path",
    title: "Golden Path",
    outcome: "Complete one governed Task through a local Agent.",
  });

  const goal = value(await runtime.createGoal("Ship the governed golden path."));
  const goalId = objectId(goal);
  const task = value(
    await runtime.createTask(goalId, "Produce and verify one bounded Artifact."),
  );
  const taskId = objectId(task);
  const agent = value(await runtime.registerAgent("local-worker", "local"));
  const agentId = objectId(agent);
  const dispatch = value(await runtime.dispatch(taskId, agentId));
  const assignmentId = dispatch.assignmentId as string;

  const workspace = runtime.workspace(taskId, assignmentId, agentId);
  assert.equal(workspace.kind, "Workspace");
  assert.equal(
    ((workspace.context as JsonObject).task as JsonObject).id,
    taskId,
  );

  await assert.rejects(
    runtime.verify(taskId, assignmentId),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-VERIFY-001",
  );
  await writeFile(join(projectRoot, "result.txt"), "real repository change\n", "utf8");
  await runtime.callback(assignmentId, "verified", ["artifact_worker_evidence"]);
  assert.equal((runtime.getRecord("Task", taskId).data.status as JsonObject).phase, "verifying");
  assert.equal(runtime.listRecords("Verification").length, 0);
  const formalEvidence = await runLocalVerification(
    projectRoot,
    taskId,
    assignmentId,
    verificationPlan(["result.txt"]),
  );
  await assert.rejects(
    runtime.verify(
      taskId,
      assignmentId,
      agentId,
      "command_provider_cannot_verify",
      formalEvidence,
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-VERIFY-002",
  );
  const verification = value(await runtime.verify(
    taskId,
    assignmentId,
    "agent_repository_verifier",
    "command_runtime_repository_verify",
    formalEvidence,
  ));
  assert.equal((verification.verificationIds as unknown[]).length, 2);
  assert.equal((runtime.getRecord("Task", taskId).data.status as JsonObject).phase, "done");
  assert.equal(runtime.getRecord("Assignment", assignmentId).data.state, "closed");
  assert.equal(runtime.listRecords("Verification").length, 2);

  const finalDigest = runtime.stateDigest();
  await runtime.rebuildProjections();
  runtime.close();
  const reopened = await PkrRuntime.open(projectRoot, repositoryRoot);
  assert.equal(reopened.stateDigest(), finalDigest);
  assert.equal((reopened.getRecord("Task", taskId).data.status as JsonObject).phase, "done");
  reopened.close();
});

test("tampered or failed repository Verification cannot create acceptance", async () => {
  const projectRoot = await temporaryProject();
  const runtime = await PkrRuntime.init(projectRoot, repositoryRoot, {
    name: "verification-failure",
    title: "Verification Failure",
    outcome: "Fail closed on repository scope and command errors.",
  });
  const goal = value(await runtime.createGoal("Prove failed formal Verification"));
  const task = value(await runtime.createTask(objectId(goal), "Reject invalid evidence"));
  const agent = value(await runtime.registerAgent("verification-producer", "local"));
  const taskId = objectId(task);
  const assignmentId = (value(await runtime.dispatch(taskId, objectId(agent))).assignmentId as string);
  await writeFile(join(projectRoot, "outside.txt"), "outside declared scope\n", "utf8");
  await runtime.callback(assignmentId, "partial", []);
  const plan: VerificationPlan = {
    ...verificationPlan(["src/**"]),
    commands: [{
      id: "failing-check",
      executable: process.execPath,
      args: ["-e", "process.stderr.write('failed check'); process.exit(7)"],
      timeoutMs: 10_000,
    }],
  };
  const failedEvidence = await runLocalVerification(projectRoot, taskId, assignmentId, plan);
  assert.equal(failedEvidence.passed, false);
  assert.equal(failedEvidence.reason, "RepositoryScopeFailed");

  const beforeDigestTamper = runtime.stateDigest();
  await assert.rejects(
    runtime.verify(
      taskId,
      assignmentId,
      "agent_repository_verifier",
      "command_bad_digest",
      { ...failedEvidence, digest: "sha256:tampered" },
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-VERIFY-001",
  );
  assert.equal(runtime.stateDigest(), beforeDigestTamper);

  const { digest: _scopeDigest, ...failedContent } = failedEvidence;
  const forgedVerdictContent: JsonObject = {
    ...failedContent,
    passed: true,
    reason: "VerificationPassed",
  };
  const beforeVerdictTamper = runtime.stateDigest();
  await assert.rejects(
    runtime.verify(
      taskId,
      assignmentId,
      "agent_repository_verifier",
      "command_forged_verdict",
      { ...forgedVerdictContent, digest: digest(forgedVerdictContent) },
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-VERIFY-001",
  );
  assert.equal(runtime.stateDigest(), beforeVerdictTamper);

  const forgedContent: JsonObject = {
    ...failedContent,
    scope: { ...(failedContent.scope as JsonObject), passed: true, outsideAllowed: [] },
    passed: true,
    reason: "VerificationPassed",
  };
  const forgedEvidence: JsonObject = { ...forgedContent, digest: digest(forgedContent) };
  const beforeScopeTamper = runtime.stateDigest();
  await assert.rejects(
    runtime.verify(
      taskId,
      assignmentId,
      "agent_repository_verifier",
      "command_forged_scope",
      forgedEvidence,
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-VERIFY-001",
  );
  assert.equal(runtime.stateDigest(), beforeScopeTamper);

  const recorded = value(await runtime.verify(
    taskId,
    assignmentId,
    "agent_repository_verifier",
    "command_failed_repository_verification",
    failedEvidence,
  ));
  assert.equal(recorded.passed, false);
  assert.equal((recorded.verificationIds as string[]).length, 1);
  assert.equal(
    (runtime.getRecord("Verification", (recorded.verificationIds as string[])[0]!).data.status as JsonObject).phase,
    "failed",
  );
  assert.equal((runtime.getRecord("Task", taskId).data.status as JsonObject).phase, "blocked");
  assert.equal(runtime.getRecord("Assignment", assignmentId).data.state, "failed");
  assert.equal(runtime.listRecords("Artifact").length, 1);
  assert.equal(runtime.listRecords("Verification").filter((record) =>
    (record.data.spec as JsonObject).gate === "acceptance",
  ).length, 0);
  const finalDigest = runtime.stateDigest();
  runtime.close();

  const reopened = await PkrRuntime.open(projectRoot, repositoryRoot);
  assert.equal(reopened.stateDigest(), finalDigest);
  assert.equal((reopened.getRecord("Task", taskId).data.status as JsonObject).phase, "blocked");
  assert.equal(reopened.getRecord("Assignment", assignmentId).data.state, "failed");
  reopened.close();
});

test("idempotency, stale writes, failpoint rollback, and projection authority hold", async () => {
  const projectRoot = await temporaryProject();
  const runtime = await PkrRuntime.init(projectRoot, repositoryRoot, {
    name: "failure-paths",
    title: "Failure Paths",
    outcome: "Reject stale and partial mutations.",
  });

  const fixedCommand = "command_idempotent_001";
  const first = await runtime.createGoal(
    "Prove idempotent command replay.",
    "human_001",
    fixedCommand,
  );
  const sequenceAfterFirst = runtime.listEvents().at(-1)?.sequence;
  const second = await runtime.createGoal(
    "Prove idempotent command replay.",
    "human_001",
    fixedCommand,
  );
  assert.deepEqual(second, first);
  assert.equal(runtime.listEvents().at(-1)?.sequence, sequenceAfterFirst);
  await assert.rejects(
    runtime.createGoal("Changed command content.", "human_001", fixedCommand),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-RUNTIME-006",
  );

  const goal = value(first);
  const goalId = objectId(goal);
  const database = runtime.paths.database;
  const projectId = runtime.projectId;
  const projection = join(
    runtime.paths.projections,
    "records",
    "Goal",
    `${goalId}.json`,
  );
  await writeFile(projection, '{"tampered":true}\n', "utf8");
  await runtime.rebuildProjections();
  const rebuilt = JSON.parse(await readFile(projection, "utf8")) as JsonObject;
  assert.equal((rebuilt.metadata as JsonObject).id, goalId);
  runtime.close();

  const store = new PkrStore(database);
  assert.throws(
    () =>
      store.execute(projectId, "command_stale_001", { action: "stale" }, (transaction) => {
        transaction.putRecord("Goal", goalId, 0, goal);
        return transaction.committed({ goalId });
      }),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-RUNTIME-005",
  );
  store.close();

  const beforeFailpoint = await PkrRuntime.open(projectRoot, repositoryRoot);
  const sequenceBeforeFailpoint = beforeFailpoint.listEvents().at(-1)?.sequence;
  beforeFailpoint.close();
  const cli = resolve(repositoryRoot, "dist", "cli.js");
  const failed = spawnSync(
    process.execPath,
    [
      cli,
      "goal",
      "create",
      "--project",
      projectRoot,
      "--outcome",
      "This transaction must roll back.",
      "--command-id",
      "command_failpoint_001",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PKR_FAILPOINT: "before-commit" },
    },
  );
  assert.notEqual(failed.status, 0);

  const afterFailpoint = await PkrRuntime.open(projectRoot, repositoryRoot);
  assert.equal(afterFailpoint.listEvents().at(-1)?.sequence, sequenceBeforeFailpoint);
  assert.throws(() =>
    afterFailpoint.getRecord("Goal", derivedId("goal", "command_failpoint_001")),
  );
  afterFailpoint.close();
});

test("CLI golden path survives one process per command", async () => {
  const projectRoot = await temporaryProject();
  const initialized = runCli(projectRoot, [
    "init",
    "--name",
    "cli-golden",
    "--title",
    "CLI Golden",
    "--outcome",
    "Prove the process-boundary CLI flow.",
  ]);
  assert.equal(initialized.projectSequence, 8);

  const goalResult = runCli(projectRoot, [
    "goal",
    "create",
    "--outcome",
    "Ship the CLI path.",
  ]);
  const goalId = objectId(goalResult.value as JsonObject);
  const taskResult = runCli(projectRoot, [
    "task",
    "create",
    "--goal",
    goalId,
    "--objective",
    "Complete one CLI-managed Task.",
  ]);
  const taskId = objectId(taskResult.value as JsonObject);
  const agentResult = runCli(projectRoot, [
    "agent",
    "register",
    "--name",
    "cli-worker",
    "--provider",
    "local",
  ]);
  const agentId = objectId(agentResult.value as JsonObject);
  const dispatchResult = runCli(projectRoot, [
    "dispatch",
    "--task",
    taskId,
    "--agent",
    agentId,
  ]);
  const assignmentId = (dispatchResult.value as JsonObject).assignmentId as string;
  await writeFile(join(projectRoot, "cli-result.txt"), "CLI repository evidence\n", "utf8");
  runCli(projectRoot, [
    "callback",
    "--assignment",
    assignmentId,
    "--outcome",
    "verified",
    "--evidence",
    "artifact_cli_evidence",
  ]);
  const pending = runCli(projectRoot, ["status"]);
  assert.equal(((pending.tasks as JsonObject[])[0]!.phase), "verifying");
  assert.equal((pending.recordCounts as JsonObject).Verification ?? 0, 0);
  const evidence = await runLocalVerification(
    projectRoot,
    taskId,
    assignmentId,
    verificationPlan(["cli-result.txt"]),
  );
  const evidenceFile = join(projectRoot, ".pkr", "cli-verification.json");
  await writeFile(evidenceFile, JSON.stringify(evidence), "utf8");
  runCli(projectRoot, [
    "verify",
    "--task",
    taskId,
    "--assignment",
    assignmentId,
    "--evidence-file",
    evidenceFile,
  ]);
  const status = runCli(projectRoot, ["status"]);
  const counts = status.recordCounts as JsonObject;
  assert.equal(counts.Task, 1);
  assert.equal(counts.Verification, 2);
  assert.ok((status.projectSequence as number) > 8);
});
