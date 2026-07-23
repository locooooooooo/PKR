import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ClarificationService } from "./clarification.js";
import { LOCAL_PROCESS_ADAPTER_CONTRACT } from "./provider-contract.js";
import type {
  AgentProviderAdapter,
  ProviderExecutionResult,
} from "./provider.js";
import { PkrRuntime } from "./runtime.js";
import type { JsonObject } from "./types.js";
import { SupervisorRunner, type SupervisorConfig } from "./supervisor.js";
import { StewardService } from "./steward.js";
import type { VerificationPlan } from "./verifier.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function project(name: string): Promise<{ root: string; runtime: PkrRuntime }> {
  const root = await mkdtemp(join(tmpdir(), `pkr-supervisor-${name}-`));
  temporaryRoots.push(root);
  run("git", ["init", "-b", "main"], root);
  await writeFile(join(root, ".gitignore"), ".pkr/\n", "utf8");
  await writeFile(join(root, "README.md"), "# Supervisor test\n", "utf8");
  run("git", ["add", "."], root);
  run("git", [
    "-c", "user.name=PKR Supervisor Test", "-c", "user.email=pkr@example.invalid",
    "commit", "-m", "baseline",
  ], root);
  return {
    root,
    runtime: await PkrRuntime.init(root, repositoryRoot, {
      name,
      title: name,
      outcome: `Complete ${name} through an independently verified local lane.`,
    }),
  };
}

function plan(allowedPath: string, commandArgs = ["-e", "process.exit(0)"]): VerificationPlan {
  return {
    version: "pkr.verify/v1",
    commands: [{ id: "check", executable: process.execPath, args: commandArgs, timeoutMs: 10_000 }],
    allowedPaths: [allowedPath],
    forbiddenPaths: [".pkr/**"],
    requireChanges: true,
  };
}

async function governedTask(runtime: PkrRuntime, objective: string): Promise<{ taskId: string; agentId: string }> {
  const steward = new StewardService(runtime);
  const applied = await steward.apply(steward.prepare(objective));
  const agent = await runtime.registerAgent(`${objective}-agent`, "local");
  return {
    taskId: applied.taskId as string,
    agentId: ((agent.value as JsonObject).metadata as JsonObject).id as string,
  };
}

function config(taskId: string, agentId?: string, requirements?: string[]): SupervisorConfig {
  return {
    version: "pkr.supervisor/v1",
    taskId,
    ...(agentId ? { agentId } : {}),
    provider: { file: "injected" },
    verification: { file: "injected", actorId: "agent_independent_verifier" },
    ...(requirements ? { requiredCapabilities: requirements } : {}),
  };
}

function providerFor(root: string, onExecute?: () => void): AgentProviderAdapter {
  return {
    id: LOCAL_PROCESS_ADAPTER_CONTRACT.id,
    version: LOCAL_PROCESS_ADAPTER_CONTRACT.version,
    capabilities: [...LOCAL_PROCESS_ADAPTER_CONTRACT.capabilities],
    isolation: LOCAL_PROCESS_ADAPTER_CONTRACT.isolation,
    async execute(): Promise<ProviderExecutionResult> {
      onExecute?.();
      await writeFile(join(root, "supervisor-result.txt"), "deterministic local result\n", "utf8");
      const timestamp = new Date().toISOString();
      return {
        callback: {
          outcome: "partial",
          completed: ["local-result"],
          incomplete: ["independent-verification", "acceptance"],
          blockers: [],
          evidenceIds: [],
          outputs: [{ kind: "patch", locator: "supervisor-result.txt" }],
          nextAction: "Run independent repository Verification.",
        },
        process: {
          executable: "deterministic-fake-provider",
          args: [],
          cwd: root,
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
          extensions: { "pkr.adapter.local-process/transport": { protocol: "fake-test" } },
        },
      };
    },
  };
}

function runner(
  runtime: PkrRuntime,
  taskId: string,
  agentId?: string,
  provider?: AgentProviderAdapter,
  verificationPlan: VerificationPlan = plan("supervisor-result.txt"),
  configRequirements?: string[],
): SupervisorRunner {
  return new SupervisorRunner(
    runtime,
    config(taskId, agentId, configRequirements),
    {
      ...(provider ? { provider } : {}),
      verificationPlan,
    },
  );
}

test("Supervisor completes an explicitly configured fake lane across restart and replay", async () => {
  const { root, runtime } = await project("happy");
  const { taskId, agentId } = await governedTask(runtime, "happy-supervisor");
  let providerCalls = 0;
  const provider = providerFor(root, () => { providerCalls += 1; });
  const first = runner(runtime, taskId, agentId, provider);
  assert.equal((await first.reconcile()).action, "dispatch");
  const assignmentId = runtime.listRecords("Assignment").find((record) => record.data.taskId === taskId)!.id;
  assert.equal(runtime.getRecord("Assignment", assignmentId).data.state, "running");
  runtime.close();

  const reopened = await PkrRuntime.open(root, repositoryRoot);
  const second = runner(reopened, taskId, agentId, provider);
  assert.equal((await second.reconcile()).action, "execute");
  assert.equal(providerCalls, 1);
  assert.equal((reopened.getRecord("Task", taskId).data.status as JsonObject).phase, "verifying");
  reopened.close();

  const resumed = await PkrRuntime.open(root, repositoryRoot);
  const third = runner(resumed, taskId, agentId, provider);
  const verified = await third.reconcile();
  assert.equal(verified.action, "verify", JSON.stringify(verified));
  assert.equal(verified.nextAction, "none");
  assert.equal((resumed.getRecord("Task", taskId).data.status as JsonObject).phase, "done");
  assert.equal(resumed.listRecords("AgentMessage").length, 1);
  assert.equal(resumed.listRecords("Verification").length, 2);
  const eventCount = resumed.listEvents().length;
  const replay = await third.reconcile();
  assert.equal(replay.action, "noop");
  assert.equal(resumed.listEvents().length, eventCount);
  assert.equal(providerCalls, 1);
  resumed.close();
});

test("Supervisor preserves failed Verification evidence without acceptance", async () => {
  const { runtime, root } = await project("verification-failure");
  const { taskId, agentId } = await governedTask(runtime, "verification-failure-supervisor");
  const failingPlan = plan("supervisor-result.txt", ["-e", "process.exit(7)"]);
  const supervisor = runner(runtime, taskId, agentId, providerFor(root), failingPlan);
  await supervisor.reconcile();
  await supervisor.reconcile();
  const failed = await supervisor.reconcile();
  assert.equal(failed.action, "verify", JSON.stringify(failed));
  assert.equal(failed.outcome, "attention");
  assert.equal(failed.attention?.code, "TaskBlocked");
  assert.equal((runtime.getRecord("Task", taskId).data.status as JsonObject).phase, "blocked");
  assert.equal(runtime.listRecords("Verification").length, 1);
  assert.equal(runtime.listRecords("Verification").some((record) =>
    ((record.data.spec as JsonObject).gate as string) === "acceptance",
  ), false);
  const repeat = await supervisor.reconcile();
  assert.equal(repeat.attention?.code, "TaskBlocked");
  runtime.close();
});

test("Supervisor renews and expires Leases, then performs one governed recovery dispatch", async () => {
  const { runtime } = await project("lease-recovery");
  const { taskId, agentId } = await governedTask(runtime, "lease-recovery-supervisor");
  const supervisor = runner(runtime, taskId, agentId, providerFor(runtime.paths.root));
  assert.equal((await supervisor.reconcile()).action, "dispatch");
  const assignment = runtime.listRecords("Assignment").find((record) => record.data.taskId === taskId)!;
  const lease = runtime.listRecords("Lease").find((record) => record.data.assignmentId === assignment.id)!;
  const session = runtime.getRecord("AgentSession", lease.data.sessionId as string);
  const heartbeatAt = new Date(Date.parse(session.data.lastHeartbeat as string) + 31_000).toISOString();
  assert.equal((await supervisor.reconcile(heartbeatAt)).action, "heartbeat");
  const renewed = runtime.getRecord("Lease", lease.id);
  const expiryAt = new Date(Date.parse(renewed.data.expiresAt as string) + 1).toISOString();
  assert.equal((await supervisor.reconcile(expiryAt)).action, "expire_lease");
  const recovery = await supervisor.reconcile();
  assert.equal(recovery.action, "dispatch_recovery");
  assert.equal(runtime.listRecords("Assignment").filter((record) => record.data.state === "running").length, 1);
  assert.equal(runtime.listRecords("Assignment").filter((record) => record.data.state === "expired").length, 1);
  runtime.close();
});

test("Supervisor fails closed for protected decisions and missing explicit capabilities", async () => {
  const { runtime, root } = await project("attention");
  const protectedTask = await governedTask(runtime, "protected-supervisor");
  const taskRecord = runtime.getRecord("Task", protectedTask.taskId);
  await new ClarificationService(runtime).assess({
    trigger: "execution-checkpoint",
    subject: { kind: "Task", id: protectedTask.taskId, revision: taskRecord.revision },
    intent: "Change the security permission model before execution.",
  });
  const protectedResult = await runner(
    runtime,
    protectedTask.taskId,
    protectedTask.agentId,
    providerFor(root),
  ).reconcile();
  assert.equal(protectedResult.action, "owner_attention");
  assert.equal(protectedResult.attention?.code, "ProtectedDecisionRequired");
  assert.equal(runtime.listRecords("Assignment").length, 0);

  const missingProviderTask = await governedTask(runtime, "missing-provider-supervisor");
  const missingProviderConfig = config(missingProviderTask.taskId, missingProviderTask.agentId);
  delete missingProviderConfig.provider;
  const missingProvider = new SupervisorRunner(
    runtime,
    missingProviderConfig,
    { verificationPlan: plan("supervisor-result.txt") },
  );
  assert.equal((await missingProvider.reconcile()).attention?.code, "MissingProviderConfiguration");

  const missingAgentTask = await governedTask(runtime, "missing-agent-supervisor");
  const missingAgent = new SupervisorRunner(
    runtime,
    config(missingAgentTask.taskId),
    { provider: providerFor(root), verificationPlan: plan("supervisor-result.txt") },
  );
  assert.equal((await missingAgent.reconcile()).attention?.code, "MissingAgentConfiguration");

  const missingSkillTask = await governedTask(runtime, "missing-skill-supervisor");
  const missingSkillConfig = config(missingSkillTask.taskId, missingSkillTask.agentId);
  missingSkillConfig.skillRequirements = [{ id: "repo-inspector", capabilities: ["repository.inspect"] }];
  const missingSkill = new SupervisorRunner(
    runtime,
    missingSkillConfig,
    {
      provider: providerFor(root),
      verificationPlan: plan("supervisor-result.txt"),
      skillResolver: { resolve: () => ({ id: "repo-inspector", capabilities: [] }) },
    },
  );
  assert.equal((await missingSkill.reconcile()).attention?.code, "MissingSkillCapability");

  const missingCapabilityTask = await governedTask(runtime, "missing-capability-supervisor");
  assert.equal((await runner(
    runtime,
    missingCapabilityTask.taskId,
    missingCapabilityTask.agentId,
    providerFor(root),
    plan("supervisor-result.txt"),
    ["browser.control"],
  ).reconcile()).attention?.code, "MissingProviderCapability");
  runtime.close();
});

test("Concurrent reconcile fences Provider and Verification side effects", async () => {
  const { runtime, root } = await project("concurrency");
  const { taskId, agentId } = await governedTask(runtime, "concurrent-supervisor");
  let providerCalls = 0;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolveStarted) => { started = resolveStarted; });
  let release!: () => void;
  const releasePromise = new Promise<void>((resolveRelease) => { release = resolveRelease; });
  const provider: AgentProviderAdapter = {
    ...providerFor(root, () => { providerCalls += 1; started(); }),
    async execute(): Promise<ProviderExecutionResult> {
      providerCalls += 1;
      started();
      await releasePromise;
      await writeFile(join(root, "supervisor-result.txt"), "concurrent result\n", "utf8");
      const timestamp = new Date().toISOString();
      return {
        callback: {
          outcome: "partial",
          completed: ["local-result"],
          incomplete: ["independent-verification"],
          blockers: [],
          evidenceIds: [],
          outputs: [],
          nextAction: "Run independent repository Verification.",
        },
        process: {
          executable: "concurrent-fake-provider",
          args: [],
          cwd: root,
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
          extensions: { "pkr.adapter.local-process/transport": { protocol: "fake-test" } },
        },
      };
    },
  };
  const first = runner(runtime, taskId, agentId, provider);
  const dispatches = await Promise.all([
    first.reconcile(),
    runner(runtime, taskId, agentId, provider).reconcile(),
  ]);
  assert.equal(dispatches.every((result) => ["dispatch", "noop"].includes(result.action)), true);
  assert.equal(runtime.listRecords("Assignment").filter((record) => record.data.taskId === taskId).length, 1);
  const executing = first.reconcile();
  await startedPromise;
  const competing = await runner(runtime, taskId, agentId, provider).reconcile();
  assert.equal(competing.attention?.code, "AmbiguousExternalEffect");
  release();
  assert.equal((await executing).action, "execute");
  assert.equal(providerCalls, 1);

  const verifyPlan = plan("supervisor-result.txt", ["-e", "setTimeout(() => process.exit(0), 200)"]);
  const verifier = runner(runtime, taskId, agentId, provider, verifyPlan);
  const verifying = verifier.reconcile();
  await new Promise((resume) => setTimeout(resume, 20));
  const competingVerification = await runner(runtime, taskId, agentId, provider, verifyPlan).reconcile();
  assert.equal(competingVerification.attention?.code, "AmbiguousVerificationEffect");
  const verifiedResult = await verifying;
  assert.equal(verifiedResult.action, "verify", JSON.stringify(verifiedResult));
  assert.equal(runtime.listRecords("Verification").length, 2);
  runtime.close();
});

test("CLI watch drives the explicit configured local lane and repeated once is a no-op", async () => {
  const { root, runtime } = await project("cli");
  const { taskId, agentId } = await governedTask(runtime, "cli-supervisor");
  await writeFile(join(root, "supervisor-provider.mjs"), [
    "import { writeFileSync } from 'node:fs';",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => input += chunk);",
    "process.stdin.on('end', () => { JSON.parse(input); writeFileSync('cli-supervisor-result.txt', 'done\\n'); process.stdout.write(JSON.stringify({ outcome: 'partial', completed: ['result'], incomplete: ['independent-verification'], blockers: [], evidenceIds: [], outputs: [], nextAction: 'Run independent repository Verification.' })); });",
  ].join("\n"), "utf8");
  run("git", ["add", "supervisor-provider.mjs"], root);
  run("git", [
    "-c", "user.name=PKR Supervisor Test", "-c", "user.email=pkr@example.invalid",
    "commit", "-m", "add deterministic local provider",
  ], root);
  await writeFile(join(root, ".pkr", "provider.json"), JSON.stringify({
    version: "pkr.provider/v1",
    adapter: { id: "pkr.adapter.local-process", version: "0.6.0", capabilities: ["filesystem.read", "filesystem.write", "terminal"] },
    command: { executable: process.execPath, args: ["supervisor-provider.mjs"], timeoutMs: 10_000 },
  }), "utf8");
  await writeFile(join(root, ".pkr", "verification.json"), JSON.stringify(plan("cli-supervisor-result.txt")), "utf8");
  await writeFile(join(root, ".pkr", "supervisor.json"), JSON.stringify({
    version: "pkr.supervisor/v1",
    taskId,
    agentId,
    provider: { file: ".pkr/provider.json" },
    verification: { file: ".pkr/verification.json", actorId: "agent_independent_verifier" },
  }), "utf8");
  runtime.close();

  const cliPath = resolve(repositoryRoot, "dist", "cli.js");
  const watched = spawnSync(process.execPath, [cliPath, "supervise", "--watch", "--interval", "100", "--project", root], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(watched.status, 0, `${watched.stderr}\n${watched.stdout}`);
  const results = watched.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as JsonObject);
  assert.deepEqual(results.map((result) => result.action), ["dispatch", "execute", "verify"]);
  const repeated = spawnSync(process.execPath, [cliPath, "supervise", "--once", "--project", root], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal((JSON.parse(repeated.stdout) as JsonObject).action, "noop");
  const finalRuntime = await PkrRuntime.open(root, repositoryRoot);
  assert.equal((finalRuntime.getRecord("Task", taskId).data.status as JsonObject).phase, "done");
  assert.equal(finalRuntime.listRecords("AgentMessage").length, 1);
  finalRuntime.close();
});
