import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { PkrError } from "./errors.js";
import { LpsOrchestrator } from "./lps.js";
import {
  LOCAL_PROCESS_ADAPTER_CONTRACT,
  type AgentProviderAdapter,
  type ProviderExecutionResult,
} from "./provider.js";
import { PkrRuntime } from "./runtime.js";
import {
  CANDIDATE_STORE_FORMAT,
  PkrStore,
  PUBLIC_ALPHA_STORE_FORMAT,
} from "./store.js";
import type { JsonObject } from "./types.js";
import { derivedId, sha256 } from "./util.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];

async function temporaryProject(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pkr-${prefix}-`));
  temporaryRoots.push(root);
  const init = spawnSync("git", ["init", "-b", "main"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  await writeFile(join(root, ".gitignore"), ".pkr/\n", "utf8");
  await writeFile(join(root, "README.md"), `# ${prefix}\n`, "utf8");
  assert.equal(spawnSync("git", ["add", "."], { cwd: root }).status, 0);
  const commit = spawnSync(
    "git",
    ["-c", "user.name=PKR Test", "-c", "user.email=pkr@example.invalid", "commit", "-m", "baseline"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(commit.status, 0, commit.stderr);
  return root;
}

async function initializedRuntime(name: string): Promise<PkrRuntime> {
  const root = await temporaryProject(name);
  return PkrRuntime.init(root, repositoryRoot, {
    name,
    title: name,
    outcome: `Prove ${name} recovery behavior.`,
  });
}

function value(result: { value?: JsonObject }): JsonObject {
  assert.ok(result.value);
  return result.value;
}

function objectId(object: JsonObject): string {
  return (object.metadata as JsonObject).id as string;
}

async function taskAndAgents(runtime: PkrRuntime): Promise<{
  taskId: string;
  firstAgentId: string;
  secondAgentId: string;
}> {
  const goal = value(await runtime.createGoal("Recover one interrupted execution."));
  const task = value(await runtime.createTask(objectId(goal), "Complete after a bounded interruption."));
  const first = value(await runtime.registerAgent("recovery-worker-a", "agent-native"));
  const second = value(await runtime.registerAgent("recovery-worker-b", "agent-native"));
  return {
    taskId: objectId(task),
    firstAgentId: objectId(first),
    secondAgentId: objectId(second),
  };
}

afterEach(async () => {
  delete process.env.PKR_FAILPOINT;
  while (temporaryRoots.length) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

test("restart expires an interrupted Session and permits one reassignment without duplicate live work", async () => {
  const runtime = await initializedRuntime("restart-reassignment");
  const { taskId, firstAgentId, secondAgentId } = await taskAndAgents(runtime);
  const firstClaim = await new LpsOrchestrator(runtime).claim(taskId, firstAgentId, "agent-native://first");
  const initialSessionExpiry = runtime.getRecord("AgentSession", firstClaim.sessionId).data.expiresAt as string;
  await new LpsOrchestrator(runtime).heartbeat(firstClaim.assignmentId);
  const renewedSessionExpiry = runtime.getRecord("AgentSession", firstClaim.sessionId).data.expiresAt as string;
  const renewedLeaseExpiry = runtime.getRecord("Lease", firstClaim.leaseId).data.expiresAt as string;
  assert.equal(renewedSessionExpiry, renewedLeaseExpiry);
  assert.ok(Date.parse(renewedSessionExpiry) >= Date.parse(initialSessionExpiry));
  const database = runtime.paths.database;
  const projectRoot = runtime.paths.root;
  const projectId = runtime.projectId;
  runtime.close();

  // Failure injection: persist an already elapsed Session/Lease without running recovery yet.
  const store = new PkrStore(database);
  store.execute(projectId, "inject_elapsed_execution", { action: "injectElapsedExecution" }, (transaction) => {
    const lease = transaction.getRecord("Lease", firstClaim.leaseId)!;
    const session = transaction.getRecord("AgentSession", firstClaim.sessionId)!;
    transaction.putRecord("Lease", lease.id, lease.revision, {
      ...lease.data,
      revision: lease.revision + 1,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    transaction.putRecord("AgentSession", session.id, session.revision, {
      ...session.data,
      revision: session.revision + 1,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    return transaction.committed({ injected: true });
  });
  store.close();

  const reopened = await PkrRuntime.open(projectRoot, repositoryRoot);
  assert.equal(reopened.getRecord("Assignment", firstClaim.assignmentId).data.state, "expired");
  assert.equal(reopened.getRecord("AgentSession", firstClaim.sessionId).data.state, "expired");
  assert.equal(reopened.getRecord("Lease", firstClaim.leaseId).data.state, "expired");
  assert.equal((reopened.getRecord("Task", taskId).data.status as JsonObject).phase, "blocked");
  await assert.rejects(
    reopened.callback(firstClaim.assignmentId, "partial"),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-COORD-008",
  );

  const secondClaim = await new LpsOrchestrator(reopened).claim(
    taskId,
    secondAgentId,
    "agent-native://second",
  );
  assert.notEqual(secondClaim.assignmentId, firstClaim.assignmentId);
  assert.equal(secondClaim.reused, false);
  assert.equal(reopened.getRecord("Assignment", secondClaim.assignmentId).data.state, "running");
  assert.equal(
    reopened.listRecords("Lease").filter((record) =>
      ["active", "renewed"].includes(record.data.state as string),
    ).length,
    1,
  );
  assert.equal(
    reopened.listRecords("Assignment").filter((record) => record.data.state === "running").length,
    1,
  );
  const replay = await new LpsOrchestrator(reopened).claim(taskId, secondAgentId);
  assert.equal(replay.assignmentId, secondClaim.assignmentId);
  assert.equal(replay.reused, true);
  await assert.rejects(
    reopened.dispatch(taskId, firstAgentId, "duplicate_live_dispatch"),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-COORD-006",
  );
  await new LpsOrchestrator(reopened).submit(secondClaim.assignmentId, secondAgentId, {
    outcome: "partial",
    completed: ["reassignment"],
    incomplete: ["independent-repository-verification"],
    blockers: [],
    evidenceIds: [],
    outputs: [],
    nextAction: "Run independent repository Verification.",
  });
  const executionRuns = reopened.listRecords("WorkflowRun").filter(
    (record) => (record.data.scope as JsonObject).taskId === taskId,
  );
  assert.equal(executionRuns.filter((record) => record.data.state === "blocked").length, 1);
  assert.equal(executionRuns.filter((record) => record.data.state === "verifying").length, 1);
  reopened.close();
});

test("fake Provider execution is fenced across restart and an unknown effect is never rerun", async () => {
  const runtime = await initializedRuntime("effect-fence");
  const { taskId, firstAgentId, secondAgentId } = await taskAndAgents(runtime);
  let calls = 0;
  const fakeProvider: AgentProviderAdapter = {
    id: "pkr.adapter.local-process",
    version: "0.6.0",
    capabilities: ["filesystem.read", "filesystem.write", "terminal"],
    isolation: LOCAL_PROCESS_ADAPTER_CONTRACT.isolation,
    async execute(): Promise<ProviderExecutionResult> {
      calls += 1;
      const timestamp = new Date().toISOString();
      return {
        callback: {
          outcome: "partial",
          completed: ["fake-provider-effect"],
          incomplete: ["independent-repository-verification"],
          blockers: [],
          evidenceIds: [],
          outputs: [],
          nextAction: "Run independent repository Verification.",
        },
        process: {
          executable: "fake-provider",
          args: [],
          cwd: runtime.paths.root,
          exitCode: 0,
          signal: null,
          stdout: "{}",
          stderr: "",
          timedOut: false,
          outputTruncated: false,
          failureReason: null,
          startedAt: timestamp,
          completedAt: timestamp,
          durationMs: 0,
          extensions: {
            "pkr.adapter.local-process/transport": {
              protocol: "fake-recovery-test",
            },
          },
        },
      };
    },
  };

  process.env.PKR_FAILPOINT = "after-provider-effect";
  await assert.rejects(new LpsOrchestrator(runtime, fakeProvider).executeLane(taskId, firstAgentId));
  assert.equal(calls, 1);
  const projectRoot = runtime.paths.root;
  runtime.close();
  delete process.env.PKR_FAILPOINT;

  const reopened = await PkrRuntime.open(projectRoot, repositoryRoot);
  const resumed = await new LpsOrchestrator(reopened, fakeProvider).executeLane(taskId, firstAgentId);
  assert.equal(calls, 1, "completed Provider effect must be replayed from SQLite, not executed twice");
  assert.equal(reopened.getRecord("Assignment", resumed.assignmentId).data.state, "submitted");

  const secondGoal = value(await reopened.createGoal("Prove unknown effect handling."));
  const secondTask = value(await reopened.createTask(objectId(secondGoal), "Do not retry an unknown effect."));
  process.env.PKR_FAILPOINT = "after-provider-execute";
  await assert.rejects(
    new LpsOrchestrator(reopened, fakeProvider).executeLane(objectId(secondTask), firstAgentId),
  );
  assert.equal(calls, 2);
  delete process.env.PKR_FAILPOINT;
  await assert.rejects(
    new LpsOrchestrator(reopened, fakeProvider).executeLane(objectId(secondTask), firstAgentId),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-RECOVERY-003",
  );
  assert.equal(calls, 2, "pending effect with unknown outcome must fail closed without rerun");

  const pendingAssignment = reopened.listRecords("Assignment").find(
    (record) => record.data.taskId === objectId(secondTask),
  )!;
  const pendingLease = reopened.listRecords("Lease").find(
    (record) => record.data.assignmentId === pendingAssignment.id,
  )!;
  await reopened.expireLease(pendingLease.id, "expire_pending_effect_assignment");
  await assert.rejects(
    new LpsOrchestrator(reopened).claim(objectId(secondTask), secondAgentId),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-RECOVERY-003",
  );
  const effectSnapshot = join(reopened.paths.root, "effect-journal.snapshot.json");
  const firstEffectId = derivedId("effect", `provider:${resumed.assignmentId}:execute`);
  const secondEffectId = derivedId("effect", `provider:${pendingAssignment.id}:execute`);
  reopened.createSnapshot(effectSnapshot);
  reopened.close();
  const restoredRoot = await temporaryProject("effect-journal-restore");
  const restored = await PkrRuntime.restore(effectSnapshot, restoredRoot, repositoryRoot);
  assert.equal(restored.externalEffect(firstEffectId)?.state, "succeeded");
  assert.equal(restored.externalEffect(secondEffectId)?.state, "pending");
  restored.close();
});

test("long history compacts with full replay and restores from a checksummed snapshot", async () => {
  const runtime = await initializedRuntime("long-history");
  const projectRoot = runtime.paths.root;
  const projectId = runtime.projectId;
  const database = runtime.paths.database;
  runtime.close();

  const store = new PkrStore(database);
  store.execute(projectId, "long_history_fixture", { action: "appendLongHistory", count: 500 }, (transaction) => {
    for (let index = 0; index < 500; index += 1) {
      transaction.appendEvent(
        "pkr.test.longHistory",
        "ProjectManifest",
        projectId,
        1,
        { index },
      );
    }
    return transaction.committed({ appended: 500 });
  });
  store.close();

  const reopened = await PkrRuntime.open(projectRoot, repositoryRoot);
  const eventCount = reopened.listEvents().length;
  const digestBefore = reopened.stateDigest();
  assert.equal(eventCount, 508);
  process.env.PKR_FAILPOINT = "compaction-after-archive";
  assert.throws(() => reopened.compact({ keepRecentEvents: 20, auditGuarantee: "full-replay" }));
  delete process.env.PKR_FAILPOINT;
  assert.equal(reopened.stateDigest(), digestBefore);
  assert.equal(reopened.listEvents().length, eventCount);

  const compacted = reopened.compact({ keepRecentEvents: 20, auditGuarantee: "full-replay" });
  assert.equal(compacted.archivedEvents, 488);
  assert.equal(compacted.liveEvents, 20);
  assert.equal(compacted.stateDigestBefore, compacted.stateDigestAfter);
  assert.equal(reopened.listEvents().length, eventCount);

  const snapshotPath = join(projectRoot, "recovery.snapshot.json");
  const snapshot = reopened.createSnapshot(snapshotPath);
  assert.equal(snapshot.projectSequence, 508);
  assert.equal(snapshot.stateDigest, digestBefore);
  reopened.close();

  const corruptPath = join(projectRoot, "corrupt.snapshot.json");
  const corrupt = JSON.parse(await readFile(snapshotPath, "utf8")) as JsonObject;
  corrupt.checksum = "0".repeat(64);
  await writeFile(corruptPath, JSON.stringify(corrupt), "utf8");
  assert.throws(
    () => PkrStore.readSnapshot(corruptPath),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-RECOVERY-002",
  );

  const partialPath = join(projectRoot, "partial.snapshot.json");
  const partial = JSON.parse(await readFile(snapshotPath, "utf8")) as JsonObject;
  delete partial.events;
  await writeFile(partialPath, JSON.stringify(partial), "utf8");
  assert.throws(
    () => PkrStore.readSnapshot(partialPath),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-RECOVERY-002",
  );

  const failedRestoreRoot = await temporaryProject("failed-restore");
  const failedDatabase = PkrRuntime.paths(failedRestoreRoot).database;
  process.env.PKR_FAILPOINT = "restore-after-data";
  assert.throws(() => PkrStore.restoreSnapshot(snapshotPath, failedDatabase));
  delete process.env.PKR_FAILPOINT;
  assert.throws(
    () => PkrStore.restoreSnapshot(snapshotPath, database),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-RECOVERY-004",
  );

  const restoredRoot = await temporaryProject("restored-history");
  const restored = await PkrRuntime.restore(snapshotPath, restoredRoot, repositoryRoot);
  assert.equal(restored.stateDigest(), digestBefore);
  assert.equal(restored.listEvents().length, eventCount);
  assert.equal(restored.listEvents().at(-1)?.sequence, 508);
  restored.close();
});

test("public alpha upgrade and bounded downgrade reject unsupported, partial, stale, and corrupt stores", async () => {
  const runtime = await initializedRuntime("migration-matrix");
  const projectRoot = runtime.paths.root;
  const expectedDigest = runtime.stateDigest();
  const alphaPath = join(projectRoot, "public-alpha.sqlite");
  runtime.exportPublicAlpha(alphaPath);
  runtime.close();

  const alpha = new DatabaseSync(alphaPath);
  const alphaTables = (alpha
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as unknown as Array<{ name: string }>).map((row) => row.name);
  assert.deepEqual(alphaTables, ["commands", "events", "metadata", "records"]);
  assert.equal((alpha.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0);
  const alphaRecords = alpha.prepare(
    "SELECT kind, record_id, revision, data_json FROM records ORDER BY kind, record_id",
  ).all() as unknown as Array<{ kind: string; record_id: string; revision: number; data_json: string }>;
  const alphaEvents = alpha.prepare(
    "SELECT project_id, sequence, event_id, type, subject_kind, subject_id, subject_revision, " +
      "command_id, occurred_at, data_json FROM events ORDER BY sequence",
  ).all() as unknown as Array<{
    project_id: string;
    sequence: number;
    event_id: string;
    type: string;
    subject_kind: string;
    subject_id: string;
    subject_revision: number;
    command_id: string;
    occurred_at: string;
    data_json: string;
  }>;
  const publicAlphaDigest = sha256({
    records: alphaRecords.map((record) => ({
      kind: record.kind,
      id: record.record_id,
      revision: record.revision,
      data: JSON.parse(record.data_json),
    })),
    events: alphaEvents.map((event) => ({
      projectId: event.project_id,
      sequence: event.sequence,
      eventId: event.event_id,
      type: event.type,
      subjectKind: event.subject_kind,
      subjectId: event.subject_id,
      subjectRevision: event.subject_revision,
      commandId: event.command_id,
      occurredAt: event.occurred_at,
      data: JSON.parse(event.data_json),
    })),
  });
  assert.equal(publicAlphaDigest, expectedDigest);
  alpha.close();

  const upgraded = new PkrStore(alphaPath);
  assert.deepEqual(upgraded.openReport, {
    sourceFormat: PUBLIC_ALPHA_STORE_FORMAT,
    targetFormat: CANDIDATE_STORE_FORMAT,
    migrated: true,
  });
  assert.equal(upgraded.stateDigest(upgraded.findProjectId()!), expectedDigest);
  const downgradedPath = join(projectRoot, "downgraded-alpha.sqlite");
  upgraded.exportPublicAlpha(upgraded.findProjectId()!, downgradedPath);
  upgraded.close();

  const failpointPath = join(projectRoot, "migration-failpoint.sqlite");
  await copyFile(downgradedPath, failpointPath);
  process.env.PKR_FAILPOINT = "migration-after-schema";
  assert.throws(() => new PkrStore(failpointPath));
  delete process.env.PKR_FAILPOINT;
  const rolledBack = new DatabaseSync(failpointPath);
  assert.equal((rolledBack.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0);
  assert.equal(
    (rolledBack.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'event_archives'").get() as { count: number }).count,
    0,
  );
  rolledBack.close();
  const retried = new PkrStore(failpointPath);
  assert.equal(retried.openReport.migrated, true);
  retried.close();

  const unsupportedPath = join(projectRoot, "unsupported.sqlite");
  await copyFile(downgradedPath, unsupportedPath);
  const unsupported = new DatabaseSync(unsupportedPath);
  unsupported.prepare("INSERT INTO metadata(key, value) VALUES ('store_format', 'pkr.store/v99')").run();
  unsupported.exec("PRAGMA user_version = 99");
  unsupported.close();
  assert.throws(
    () => new PkrStore(unsupportedPath),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-MIGRATION-001",
  );

  const partialPath = join(projectRoot, "partial.sqlite");
  const partial = new DatabaseSync(partialPath);
  partial.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  partial.close();
  assert.throws(
    () => new PkrStore(partialPath),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-MIGRATION-002",
  );

  const stalePath = join(projectRoot, "stale.sqlite");
  await copyFile(downgradedPath, stalePath);
  const stale = new DatabaseSync(stalePath);
  stale.prepare("UPDATE metadata SET value = '999' WHERE key = 'project_sequence'").run();
  stale.close();
  assert.throws(
    () => new PkrStore(stalePath),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-MIGRATION-003",
  );

  const corruptPath = join(projectRoot, "corrupt.sqlite");
  await writeFile(corruptPath, "not a sqlite database", "utf8");
  assert.throws(
    () => new PkrStore(corruptPath),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-MIGRATION-004",
  );
});
