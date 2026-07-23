import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { PkrError } from "./errors.js";
import { buildShareableProjection, ShareableProjectionError } from "./projection.js";
import { PkrRuntime } from "./runtime.js";
import { PkrStore } from "./store.js";
import type { JsonObject } from "./types.js";
import { derivedId, digest } from "./util.js";
import { runLocalVerification, type VerificationPlan } from "./verifier.js";
import { collectRepositoryEvidence } from "./workspace.js";

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

test("shareable projection redacts repeated repository evidence without changing its source digest", () => {
  const rawDiff = "diff --git a/src/private.ts b/src/private.ts\n+Bearer eyJhbGciOiJub25lIn0.payload.signature\n".repeat(8_000);
  const source: JsonObject = {
    projectId: "project_shareable_001",
    digest: "sha256:authoritative-state",
    records: [{
      projectId: "project_shareable_001",
      kind: "Verification",
      id: "verification_001",
      revision: 1,
      updatedAt: "2026-07-23T00:00:00.000Z",
      data: {
        repositoryRoot: "E:\\PKR\\private-repository",
        diff: rawDiff,
        stagedDiff: rawDiff,
        commands: [{
          stdout: "C:\\Users\\operator\\output\nBearer secret-token-value",
          stderr: "failure detail",
        }],
        provider: {
          [["access", "Token"].join("")]: ["secret", "access", "token"].join("-"),
        },
        privatePrompt: "Do not publish this private system prompt.",
        unclassifiedValues: [
          ["sk", "-proj-", "abcdefghijklmnopqrstuvwx"].join(""),
          ["ghp", "_", "abcdefghijklmnopqrstuvwxyz1234567890"].join(""),
          ["AK", "IA", "1234567890ABCDEF"].join(""),
          ["AI", "za", "123456789012345678901234567890123"].join(""),
          ["xoxb", "-", "1234567890-abcdefghijkl"].join(""),
        ],
      },
    }],
    events: [{
      projectId: "project_shareable_001",
      sequence: 1,
      data: {
        cwd: "E:\\PKR\\private-repository",
        stdout: rawDiff,
      },
    }],
  };

  const shareable = buildShareableProjection(source);
  const output = JSON.stringify(shareable);
  const redaction = shareable.redaction as JsonObject;
  const notices = redaction.notices as JsonObject[];
  const rawEvidence = notices.filter((notice) => notice.reason === "raw-evidence");

  assert.equal(shareable.sourceStateDigest, source.digest);
  assert.match(shareable.digest as string, /^sha256:/);
  assert.equal(rawEvidence.length, 5);
  assert.equal(rawEvidence[0]?.digest, rawEvidence[1]?.digest);
  assert.doesNotMatch(output, /diff --git/);
  assert.doesNotMatch(output, /E:\\PKR\\private-repository/);
  assert.doesNotMatch(output, /C:\\Users\\operator/);
  assert.doesNotMatch(output, /secret-access-token/);
  assert.doesNotMatch(output, /private system prompt/);
  assert.doesNotMatch(output, /sk-proj-/);
  assert.doesNotMatch(output, /ghp_/);
  assert.doesNotMatch(output, /AKIA123/);
  assert.doesNotMatch(output, /AIza/);
  assert.doesNotMatch(output, /xoxb-/);
  assert.doesNotMatch(output, /eyJhbGciOiJub25lIn0/);
  assert.match(output, /Raw evidence remains in SQLite authority/);
  for (const notice of notices.filter((notice) => notice.reason !== "raw-evidence")) {
    assert.equal("digest" in notice, false);
    assert.equal("bytes" in notice, false);
  }
  const serializedBytes = Buffer.byteLength(`${JSON.stringify(shareable, null, 2)}\n`, "utf8");
  assert.doesNotThrow(() => buildShareableProjection(source, { maxBytes: serializedBytes }));
  assert.throws(
    () => buildShareableProjection(source, { maxBytes: serializedBytes - 1 }),
    (error: unknown) =>
      error instanceof ShareableProjectionError && error.code === "PKR-PROJECTION-003",
  );
});

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

test("local golden path reaches done only after callback and two gates", async () => {
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

  const repositoryEvidence = await collectRepositoryEvidence(projectRoot);
  const workspace = runtime.workspace(
    taskId,
    assignmentId,
    agentId,
    repositoryEvidence as unknown as JsonObject,
  );
  assert.equal(workspace.kind, "Workspace");
  assert.equal(
    ((workspace.context as JsonObject).task as JsonObject).id,
    taskId,
  );
  assert.equal(
    ((workspace.extensions as JsonObject)["pkr.workspace/repository"] as JsonObject).head,
    repositoryEvidence.head,
  );

  await assert.rejects(
    runtime.verify(taskId, assignmentId),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-VERIFY-001",
  );
  await writeFile(join(projectRoot, "result.txt"), "real repository change\n", "utf8");
  await runtime.callback(assignmentId, "partial", []);
  const formalEvidence = await runLocalVerification(
    projectRoot,
    taskId,
    assignmentId,
    verificationPlan(["result.txt"]),
  );
  const beforeProviderVerification = runtime.stateDigest();
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
  assert.equal(runtime.stateDigest(), beforeProviderVerification);
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

test("RepositoryEvidence is content-addressed once across Session, Message, and Verification", async () => {
  const projectRoot = await temporaryProject();
  const rawNeedle = "PKR_LARGE_EVIDENCE_SENTINEL_";
  const runtime = await PkrRuntime.init(projectRoot, repositoryRoot, {
    name: "evidence-dedup",
    title: "Evidence Dedup",
    outcome: "Persist one authoritative RepositoryEvidence payload.",
  });
  await writeFile(
    join(projectRoot, "README.md"),
    `# Runtime test repository\n${rawNeedle}${"repository evidence payload\n".repeat(12_000)}`,
    "utf8",
  );
  const goalId = objectId(value(await runtime.createGoal("Deduplicate repository evidence.")));
  const taskId = objectId(value(await runtime.createTask(goalId, "Use one large evidence snapshot.")));
  const agentId = objectId(value(await runtime.registerAgent("evidence-producer", "local")));
  const rawEvidence = await collectRepositoryEvidence(projectRoot);
  assert.ok(rawEvidence.diff.length > 250_000);
  const dispatchCommand = "command_repository_evidence_dispatch";
  const dispatch = await runtime.dispatch(taskId, agentId, dispatchCommand, {
    executionMode: "agent-native",
    repositoryBaseline: rawEvidence as unknown as JsonObject,
  });
  assert.deepEqual(
    await runtime.dispatch(taskId, agentId, dispatchCommand, {
      executionMode: "agent-native",
      repositoryBaseline: {
        ...rawEvidence,
        collectedAt: "2099-01-01T00:00:00.000Z",
      } as unknown as JsonObject,
    }),
    dispatch,
  );
  const assignmentId = (dispatch.value as JsonObject).assignmentId as string;
  const sessionId = (dispatch.value as JsonObject).sessionId as string;
  const session = runtime.getRecord("AgentSession", sessionId);
  const native = (session.data.extensions as JsonObject)["pkr.agent-native/session"] as JsonObject;
  const baselineRef = native.repositoryBaseline as JsonObject;
  assert.equal(baselineRef.refVersion, "pkr.repository-evidence-ref/v1");
  assert.equal(baselineRef.contentDigest, rawEvidence.contentDigest);
  assert.equal("diff" in baselineRef, false);

  const callbackCommand = "command_repository_evidence_callback";
  const callback = await runtime.callback(
    assignmentId,
    "partial",
    [],
    callbackCommand,
    undefined,
    undefined,
    {
      baseline: rawEvidence as unknown as JsonObject,
      current: rawEvidence as unknown as JsonObject,
    },
  );
  const message = runtime.getRecord(
    "AgentMessage",
    (callback.value as JsonObject).messageId as string,
  );
  const workspaceEvidence = (message.data.extensions as JsonObject)["pkr.workspace/evidence"] as JsonObject;
  assert.equal((workspaceEvidence.baseline as JsonObject).contentDigest, rawEvidence.contentDigest);
  assert.equal((workspaceEvidence.current as JsonObject).contentDigest, rawEvidence.contentDigest);
  assert.equal("diff" in (workspaceEvidence.current as JsonObject), false);

  const formalEvidence = await runLocalVerification(
    projectRoot,
    taskId,
    assignmentId,
    verificationPlan(["README.md"]),
  );
  const verifyCommand = "command_repository_evidence_verify";
  const verified = await runtime.verify(
    taskId,
    assignmentId,
    "agent_repository_verifier",
    verifyCommand,
    formalEvidence,
  );
  const artifact = runtime.getRecord("Artifact", (verified.value as JsonObject).artifactId as string);
  const persistedVerification = (artifact.data.extensions as JsonObject)["pkr.verification/repository"] as JsonObject;
  const repositoryRef = persistedVerification.repository as JsonObject;
  assert.equal(repositoryRef.contentDigest, rawEvidence.contentDigest);
  assert.equal("diff" in repositoryRef, false);
  const verificationStateDigest = runtime.stateDigest();
  const databasePath = runtime.paths.database;
  const projectId = runtime.projectId;
  const snapshotPath = join(projectRoot, "repository-evidence.snapshot.json");
  const snapshot = runtime.createSnapshot(snapshotPath);
  assert.equal(snapshot.repositoryEvidence?.length, 1);
  assert.throws(
    () => runtime.exportPublicAlpha(join(projectRoot, "unsupported-evidence-downgrade.sqlite")),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-MIGRATION-005",
  );
  await runtime.rebuildProjections();
  runtime.close();

  const database = new DatabaseSync(databasePath);
  const evidenceCount = database
    .prepare("SELECT COUNT(*) AS count FROM repository_evidence WHERE project_id = ?")
    .get(projectId) as { count: number };
  assert.equal(evidenceCount.count, 1);
  for (const table of ["records", "events", "commands"] as const) {
    const column = table === "records" ? "data_json" : table === "events" ? "data_json" : "result_json";
    const rawCount = database
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ? AND instr(${column}, ?) > 0`)
      .get(projectId, rawNeedle) as { count: number };
    assert.equal(rawCount.count, 0, `${table} must not contain raw RepositoryEvidence`);
  }
  const payload = database
    .prepare("SELECT payload_json FROM repository_evidence WHERE project_id = ?")
    .get(projectId) as { payload_json: string };
  assert.match(payload.payload_json, new RegExp(rawNeedle));
  database.close();

  const stateProjection = JSON.parse(
    await readFile(join(projectRoot, ".pkr", "projections", "state.json"), "utf8"),
  ) as JsonObject;
  assert.doesNotMatch(JSON.stringify(stateProjection), new RegExp(rawNeedle));
  const evidenceFiles = stateProjection.repositoryEvidence as JsonObject[];
  assert.equal(evidenceFiles.length, 1);
  const evidenceProjection = JSON.parse(
    await readFile(
      join(
        projectRoot,
        ".pkr",
        "projections",
        "repository-evidence",
        `${rawEvidence.contentDigest.replace(/^sha256:/, "")}.json`,
      ),
      "utf8",
    ),
  ) as JsonObject;
  assert.match(JSON.stringify(evidenceProjection), new RegExp(rawNeedle));

  const reopened = await PkrRuntime.open(projectRoot, repositoryRoot);
  assert.equal(reopened.stateDigest(), verificationStateDigest);
  const resolved = reopened.resolveRepositoryEvidence(baselineRef);
  assert.equal(resolved.diff, rawEvidence.diff);
  assert.equal(resolved.collectedAt, rawEvidence.collectedAt);
  assert.throws(
    () => reopened.resolveRepositoryEvidence({
      ...baselineRef,
      byteLength: (baselineRef.byteLength as number) + 1,
    }),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVIDENCE-002",
  );
  assert.deepEqual(
    await reopened.verify(
      taskId,
      assignmentId,
      "agent_repository_verifier",
      verifyCommand,
      formalEvidence,
    ),
    verified,
  );
  reopened.close();

  const restoredRoot = await temporaryProject();
  const restored = await PkrRuntime.restore(snapshotPath, restoredRoot, repositoryRoot);
  assert.equal(restored.stateDigest(), verificationStateDigest);
  assert.equal(restored.resolveRepositoryEvidence(baselineRef).diff, rawEvidence.diff);
  restored.close();
});

test("legacy inline RepositoryEvidence remains resolvable and projects as one ref", async () => {
  const projectRoot = await temporaryProject();
  const runtime = await PkrRuntime.init(projectRoot, repositoryRoot, {
    name: "legacy-evidence",
    title: "Legacy Evidence",
    outcome: "Read legacy inline RepositoryEvidence without lossy migration.",
  });
  const databasePath = runtime.paths.database;
  const projectId = runtime.projectId;
  const rawEvidence = await collectRepositoryEvidence(projectRoot);
  runtime.close();

  const store = new PkrStore(databasePath);
  store.execute(projectId, "command_legacy_inline_evidence", { action: "legacyEvidence" }, (transaction) => {
    transaction.putRecord(
      "LegacyRepositoryEvidence",
      "legacy_repository_evidence_001",
      0,
      { repository: rawEvidence as unknown as JsonObject },
    );
    return transaction.committed({ migrated: false });
  });
  assert.equal(store.listRepositoryEvidence(projectId).length, 0);
  assert.equal(store.projectionRepositoryEvidence(projectId).length, 1);
  const projected = store.projectionRecords(projectId).find(
    (record) => record.kind === "LegacyRepositoryEvidence",
  )!;
  const ref = projected.data.repository as JsonObject;
  assert.equal(ref.contentDigest, rawEvidence.contentDigest);
  assert.equal("diff" in ref, false);
  assert.equal(store.resolveRepositoryEvidence(projectId, ref).diff, rawEvidence.diff);
  store.close();

  const reopened = await PkrRuntime.open(projectRoot, repositoryRoot);
  await reopened.rebuildProjections();
  reopened.close();
  const state = await readFile(join(projectRoot, ".pkr", "projections", "state.json"), "utf8");
  assert.doesNotMatch(state, /"diff"/);
  assert.match(state, /pkr\.repository-evidence-ref\/v1/);
});

test("RepositoryEvidence blob insertion rolls back with its Runtime command", async () => {
  const projectRoot = await temporaryProject();
  const runtime = await PkrRuntime.init(projectRoot, repositoryRoot, {
    name: "evidence-rollback",
    title: "Evidence Rollback",
    outcome: "Roll back evidence and records atomically.",
  });
  const databasePath = runtime.paths.database;
  const projectId = runtime.projectId;
  const rawEvidence = await collectRepositoryEvidence(projectRoot);
  runtime.close();

  const store = new PkrStore(databasePath);
  process.env.PKR_FAILPOINT = "before-commit";
  try {
    assert.throws(() =>
      store.execute(projectId, "command_evidence_failpoint", { action: "evidenceFailpoint" }, (transaction) => {
        transaction.putRepositoryEvidence(rawEvidence as unknown as JsonObject);
        return transaction.committed({ persisted: true });
      }),
    );
  } finally {
    delete process.env.PKR_FAILPOINT;
  }
  assert.equal(store.listRepositoryEvidence(projectId).length, 0);
  store.close();
});

test("failed repository Verification preserves evidence and cannot be forged into acceptance", async () => {
  const projectRoot = await temporaryProject();
  const runtime = await PkrRuntime.init(projectRoot, repositoryRoot, {
    name: "verification-failure",
    title: "Verification Failure",
    outcome: "Fail closed on real repository scope and command errors.",
  });
  const goal = value(await runtime.createGoal("Prove failed formal Verification"));
  const task = value(await runtime.createTask(objectId(goal), "Reject invalid repository evidence"));
  const agent = value(await runtime.registerAgent("verification-producer", "local"));
  const taskId = objectId(task);
  const assignmentId = (value(await runtime.dispatch(taskId, objectId(agent))).assignmentId as string);
  await writeFile(join(projectRoot, "outside.txt"), "outside declared scope\n", "utf8");
  await runtime.callback(assignmentId, "partial", []);
  const plan: VerificationPlan = {
    version: "pkr.verify/v1",
    commands: [{
      id: "failing-check",
      executable: process.execPath,
      args: ["-e", "process.stderr.write('failed check'); process.exit(7)"],
      timeoutMs: 10_000,
    }],
    allowedPaths: ["src/**"],
    forbiddenPaths: [".pkr/**"],
    requireChanges: true,
  };
  const failedEvidence = await runLocalVerification(
    projectRoot,
    taskId,
    assignmentId,
    plan,
  );
  assert.equal(failedEvidence.passed, false);
  assert.equal(failedEvidence.reason, "RepositoryScopeFailed");
  assert.equal(((failedEvidence.scope as JsonObject).outsideAllowed as string[]).includes("outside.txt"), true);
  assert.equal(((failedEvidence.commands as JsonObject[])[0]!.exitCode), 7);
  assert.equal(((failedEvidence.commands as JsonObject[])[0]!.stderr as string), "failed check");

  const scopeOnlyEvidence = await runLocalVerification(
    projectRoot,
    taskId,
    assignmentId,
    {
      ...plan,
      commands: [{
        id: "passing-check",
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        timeoutMs: 10_000,
      }],
    },
  );
  const { digest: _scopeDigest, ...scopeOnlyContent } = scopeOnlyEvidence;
  const forgedScopeContent: JsonObject = {
    ...scopeOnlyContent,
    scope: { ...(scopeOnlyContent.scope as JsonObject), passed: true },
    passed: true,
    reason: "VerificationPassed",
  };
  const forgedScopeEvidence: JsonObject = {
    ...forgedScopeContent,
    digest: digest(forgedScopeContent),
  };
  const beforeScopeForgery = runtime.stateDigest();
  await assert.rejects(
    runtime.verify(
      taskId,
      assignmentId,
      "agent_repository_verifier",
      "command_forged_scope_verification",
      forgedScopeEvidence,
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-VERIFY-001",
  );
  assert.equal(runtime.stateDigest(), beforeScopeForgery);

  const { digest: _oldDigest, ...failedContent } = failedEvidence;
  const forgedContent: JsonObject = {
    ...failedContent,
    passed: true,
    reason: "VerificationPassed",
  };
  const forgedEvidence: JsonObject = { ...forgedContent, digest: digest(forgedContent) };
  const beforeForgery = runtime.stateDigest();
  await assert.rejects(
    runtime.verify(
      taskId,
      assignmentId,
      "agent_repository_verifier",
      "command_forged_verification",
      forgedEvidence,
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-VERIFY-001",
  );
  assert.equal(runtime.stateDigest(), beforeForgery);

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
  assert.equal(runtime.listRecords("Verification").filter((record) =>
    (record.data.spec as JsonObject).gate === "acceptance",
  ).length, 0);
  const failedDigest = runtime.stateDigest();
  runtime.close();

  const reopened = await PkrRuntime.open(projectRoot, repositoryRoot);
  assert.equal(reopened.stateDigest(), failedDigest);
  assert.equal((reopened.getRecord("Task", taskId).data.status as JsonObject).phase, "blocked");
  assert.equal(reopened.getRecord("Assignment", assignmentId).data.state, "failed");
  assert.equal(reopened.listRecords("Verification").filter((record) =>
    (record.data.spec as JsonObject).gate === "acceptance",
  ).length, 0);
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

  const shareablePath = join(projectRoot, ".pkr", "exports", "shareable-state.json");
  const shareableResult = runCli(projectRoot, [
    "projection",
    "export",
    "--profile",
    "shareable",
    "--output",
    shareablePath,
  ]);
  const shareableState = JSON.parse(await readFile(shareablePath, "utf8")) as JsonObject;
  const fullState = JSON.parse(
    await readFile(join(projectRoot, ".pkr", "projections", "state.json"), "utf8"),
  ) as JsonObject;
  assert.equal(shareableResult.sourceStateDigest, fullState.digest);
  assert.equal(shareableState.sourceStateDigest, fullState.digest);
  assert.equal(shareableState.profile, "shareable");

  const cli = resolve(repositoryRoot, "dist", "cli.js");
  const protectedProjectionPath = join(projectRoot, ".pkr", "projections", "state.json");
  const protectedProjectionBefore = await readFile(protectedProjectionPath, "utf8");
  const protectedExport = spawnSync(
    process.execPath,
    [
      cli,
      "projection",
      "export",
      "--profile",
      "shareable",
      "--output",
      protectedProjectionPath,
      "--project",
      projectRoot,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(protectedExport.status, 0);
  assert.match(protectedExport.stderr, /PKR-PROJECTION-004/);
  assert.equal(await readFile(protectedProjectionPath, "utf8"), protectedProjectionBefore);

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
    "--host",
    "agent-native",
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
  runCli(projectRoot, [
    "callback",
    "--assignment",
    assignmentId,
    "--outcome",
    "partial",
  ]);
  await writeFile(join(projectRoot, "cli-result.txt"), "real CLI repository change\n", "utf8");
  await writeFile(
    join(projectRoot, ".pkr", "verification.json"),
    JSON.stringify(verificationPlan(["cli-result.txt"])),
    "utf8",
  );
  runCli(projectRoot, [
    "verify",
    "--task",
    taskId,
    "--assignment",
    assignmentId,
  ]);
  const status = runCli(projectRoot, ["status"]);
  const counts = status.recordCounts as JsonObject;
  assert.equal(counts.Task, 1);
  assert.equal(counts.Verification, 2);
  assert.ok((status.projectSequence as number) > 8);
});
