import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { PkrError } from "./errors.js";
import { MemoryService } from "./memory.js";
import { PackageService } from "./packages.js";
import { STARTER_PROFILES, type ProfilePackage } from "./profiles.js";
import { PkrRuntime } from "./runtime.js";
import type { JsonObject } from "./types.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];

async function project(name: string): Promise<{ root: string; runtime: PkrRuntime }> {
  const root = await mkdtemp(join(tmpdir(), `pkr-v07-${name}-`));
  temporaryRoots.push(root);
  return {
    root,
    runtime: await PkrRuntime.init(root, repositoryRoot, {
      name,
      title: name,
      outcome: `Prove PKR v0.7 ${name}.`,
    }),
  };
}

function valueId(value: JsonObject): string {
  return ((value.metadata as JsonObject).id as string);
}

function runCli(projectRoot: string, args: string[]): JsonObject {
  const result = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, "dist", "cli.js"), ...args, "--project", projectRoot],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as JsonObject;
}

afterEach(async () => {
  while (temporaryRoots.length) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

test("Memory survives a fresh session, filters visibility, invalidates stale sources, and promotes Knowledge", async () => {
  const { root, runtime } = await project("memory");
  const goal = await runtime.createGoal("Retain only provenance-bound project context");
  const goalId = valueId(goal.value as JsonObject);
  const task = await runtime.createTask(goalId, "Create a source that will change revision");
  const taskId = valueId(task.value as JsonObject);
  const memory = new MemoryService(runtime);
  const durable = await memory.derive(
    "The project requires provenance-bound Memory.",
    [{ kind: "Goal", id: goalId, revision: 1 }],
  );
  const durableId = (durable.value as JsonObject).memoryId as string;
  const privateEntry = await memory.derive(
    "Only the owner may retrieve this context.",
    [{ kind: "Task", id: taskId, revision: 1 }],
    `principal:${runtime.ownerId()}`,
  );
  const privateId = (privateEntry.value as JsonObject).memoryId as string;
  const promoted = await memory.promote(durableId, "Governed Memory rule");
  assert.equal((promoted.value as JsonObject).kind, "Knowledge");
  assert.equal(runtime.listRecords("Knowledge").length, 1);
  assert.equal((await memory.retrieve("human_other")).some((entry) => entry.id === privateId), false);
  runtime.close();

  const reopened = await PkrRuntime.open(root, repositoryRoot);
  const reconstructed = new MemoryService(reopened);
  assert.deepEqual(
    (await reconstructed.retrieve(reopened.ownerId())).map((entry) => entry.id).sort(),
    [durableId, privateId].sort(),
  );

  const agent = await reopened.registerAgent("memory-worker", "local-process");
  const agentId = valueId(agent.value as JsonObject);
  await reopened.dispatch(taskId, agentId);
  const visible = await reconstructed.retrieve(reopened.ownerId());
  assert.equal(visible.some((entry) => entry.id === privateId), false);
  assert.notEqual(reopened.getRecord("MemoryEntry", privateId).data.invalidatedAt, null);
  assert.equal(reopened.getRecord("MemoryEntry", durableId).data.invalidatedAt, null);
  reopened.close();
});

test("starter Profiles drive distinct portable Workflows and Package activation is rollback-safe", async () => {
  const { runtime } = await project("profiles");
  const packages = new PackageService(runtime);
  const goal = await runtime.createGoal("Prove two package-defined project behaviors");
  const task = await runtime.createTask(valueId(goal.value as JsonObject), "Run profile Workflow");
  const taskId = valueId(task.value as JsonObject);
  const decision = await runtime.createDecision(
    "Install the bounded starter Profiles?",
    "Install web and library Profiles",
    "Profiles are versioned and rollback-safe.",
    ["Workflow", "Decision"],
    runtime.ownerId(),
  );
  const decisionId = valueId(decision.value as JsonObject);

  const web = await packages.installStarterProfile(
    "web",
    decisionId,
    STARTER_PROFILES.web.requestedCapabilities,
  );
  const webValue = web.value as JsonObject;
  const firstWebInstallation = webValue.installationId as string;
  const webWorkflowId = webValue.workflowId as string;
  const webRun = await runtime.startPortableWorkflow(
    webWorkflowId,
    { type: "task", taskId },
  );
  const webRunId = (webRun.value as JsonObject).runId as string;
  assert.equal((webRun.value as JsonObject).state, "plan");
  await assert.rejects(
    runtime.transitionPortableWorkflow(webRunId, "implement", { approved: false }),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-WORKFLOW-002",
  );
  const implementing = await runtime.transitionPortableWorkflow(
    webRunId,
    "implement",
    { approved: true },
  );
  assert.equal((implementing.value as JsonObject).state, "implement");
  await assert.rejects(
    runtime.transitionPortableWorkflow(webRunId, "released", { preview: "accepted" }),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-WORKFLOW-002",
  );

  const nextWeb: ProfilePackage = {
    ...STARTER_PROFILES.web,
    version: "0.7.1",
    title: "PKR Web Project Profile 0.7.1",
  };
  const upgraded = await runtime.installProfilePackage(
    nextWeb,
    decisionId,
    nextWeb.requestedCapabilities,
  );
  const upgradedId = (upgraded.value as JsonObject).installationId as string;
  assert.equal(runtime.getRecord("PackageInstallation", firstWebInstallation).data.state, "superseded");

  const failedWeb: ProfilePackage = { ...nextWeb, version: "0.7.2" };
  const beforeFailureDigest = runtime.stateDigest();
  await assert.rejects(
    runtime.installProfilePackage(
      failedWeb,
      decisionId,
      failedWeb.requestedCapabilities,
      runtime.ownerId(),
      undefined,
      true,
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-PACKAGE-004",
  );
  assert.equal(runtime.stateDigest(), beforeFailureDigest);
  assert.equal(runtime.getRecord("PackageInstallation", upgradedId).data.state, "active");

  await packages.rollback(STARTER_PROFILES.web.packageId, firstWebInstallation);
  assert.equal(runtime.getRecord("PackageInstallation", firstWebInstallation).data.state, "active");
  assert.equal(runtime.getRecord("PackageInstallation", upgradedId).data.state, "superseded");

  const library = await packages.installStarterProfile(
    "library",
    decisionId,
    STARTER_PROFILES.library.requestedCapabilities,
  );
  const libraryWorkflowId = (library.value as JsonObject).workflowId as string;
  const libraryRun = await runtime.startPortableWorkflow(
    libraryWorkflowId,
    { type: "task", taskId },
  );
  assert.equal((libraryRun.value as JsonObject).state, "design");
  assert.notDeepEqual(
    runtime.getRecord("Workflow", webWorkflowId).data.spec,
    runtime.getRecord("Workflow", libraryWorkflowId).data.spec,
  );

  const historyBeforeUninstall = runtime.listEvents().length;
  await packages.uninstall(STARTER_PROFILES.library.packageId);
  assert.equal(runtime.getRecord("PackageInstallation", (library.value as JsonObject).installationId as string).data.state, "uninstalled");
  assert.ok(runtime.listEvents().length > historyBeforeUninstall);
  await assert.rejects(
    runtime.startPortableWorkflow(libraryWorkflowId, { type: "task", taskId }),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-PACKAGE-004",
  );
  runtime.close();
});

test("v0.7 CLI reconstructs Memory and operates an installed Profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "pkr-v07-cli-"));
  temporaryRoots.push(root);
  runCli(root, ["init", "--name", "v07-cli"]);
  const goal = runCli(root, ["goal", "create", "--outcome", "Exercise v0.7 CLI"]);
  const goalId = valueId(goal.value as JsonObject);
  const task = runCli(root, ["task", "create", "--goal", goalId, "--objective", "Run Profile"]);
  const taskId = valueId(task.value as JsonObject);
  const derived = runCli(root, [
    "memory",
    "derive",
    "--summary",
    "CLI Memory survives process boundaries.",
    "--source-kind",
    "Goal",
    "--source-id",
    goalId,
    "--source-revision",
    "1",
  ]);
  const memoryId = (derived.value as JsonObject).memoryId as string;
  const memories = runCli(root, ["memory", "list"]);
  assert.equal((memories as unknown as JsonObject[]).some((entry) => entry.id === memoryId), true);

  const decision = runCli(root, [
    "decision",
    "create",
    "--question",
    "Install web Profile?",
    "--choice",
    "Install",
    "--reason",
    "Exercise the package CLI.",
    "--affected",
    "Workflow,Decision",
  ]);
  const installed = runCli(root, [
    "profile",
    "install",
    "--name",
    "web",
    "--decision",
    valueId(decision.value as JsonObject),
  ]);
  const workflowId = (installed.value as JsonObject).workflowId as string;
  const run = runCli(root, ["workflow", "start", "--workflow", workflowId, "--task", taskId]);
  const transitioned = runCli(root, [
    "workflow",
    "transition",
    "--run",
    ((run.value as JsonObject).runId as string),
    "--to",
    "implement",
    "--context",
    '{"approved":true}',
  ]);
  assert.equal((transitioned.value as JsonObject).state, "implement");
  const profiles = runCli(root, ["profile", "list"]);
  assert.equal((profiles.available as string[]).includes("library"), true);
  assert.equal((profiles.installations as JsonObject[]).length, 1);
});
