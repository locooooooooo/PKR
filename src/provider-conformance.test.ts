import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { PkrError } from "./errors.js";
import { LpsOrchestrator } from "./lps.js";
import {
  HttpJsonAdapter,
  LOCAL_PROCESS_ADAPTER_CONTRACT,
  LocalProcessAdapter,
  parseProviderCallback,
  providerCallbackFailure,
  type AgentProviderAdapter,
  type ProviderCallback,
} from "./provider.js";
import { PkrRuntime } from "./runtime.js";
import { StewardService } from "./steward.js";
import type { JsonObject } from "./types.js";
import { runLocalVerification, type VerificationPlan } from "./verifier.js";
import { collectRepositoryEvidence } from "./workspace.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerScript = resolve(repositoryRoot, "dist", "provider-worker.js");
const temporaryRoots: string[] = [];
const servers: Server[] = [];

type AdapterKind = "local-process" | "http-json";

interface AdapterHarness {
  adapter: AgentProviderAdapter;
  outputFile: string;
  transportExtension: string;
  close(): Promise<void>;
}

interface GoldenPathSemantics {
  task: string;
  assignment: string;
  session: string;
  lease: string;
  callbackOutcome: string;
  callbackCreatedVerification: boolean;
  repositoryChanged: boolean;
  verificationGates: string[];
  verifierDistinctFromWorker: boolean;
  boardWorkerState: string;
  restartBoardEquivalent: boolean;
  replayCreatedEvents: boolean;
}

interface TimeoutSemantics {
  callback: "present" | "absent";
  timedOut: boolean;
  failureReason: string | null;
  assignment: string;
  task: string;
  verificationCount: number;
}

interface RevocationSemantics {
  assignment: string;
  lease: string;
  session: string;
  task: string;
  lateCallbackPersisted: boolean;
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    if (server.listening) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }
  while (temporaryRoots.length) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

test("Provider callback contract rejects semantic drift and unnamespaced fields", () => {
  const valid = callback("result.txt");
  valid.extensions = {
    "example.provider/trace": { traceId: "trace_fake_001" },
  };
  assert.equal(providerCallbackFailure(valid), null);
  assert.deepEqual(parseProviderCallback(JSON.stringify(valid)), valid);
  assert.equal(
    providerCallbackFailure({ ...valid, providerTraceId: "trace_fake_001" }),
    "UnnamespacedCallbackField",
  );
  assert.equal(
    providerCallbackFailure({ ...valid, extensions: { traceId: "trace_fake_001" } }),
    "InvalidCallbackShape",
  );
  assert.equal(
    providerCallbackFailure({
      ...valid,
      outcome: "verified",
      incomplete: [],
      evidenceIds: [],
    }),
    "VerifiedCallbackRequiresEvidenceAndNoResidualWork",
  );
});

test("stdio process and fake HTTP adapters pass the same governed golden path", async () => {
  const local = await runGoldenPath("local-process");
  const http = await runGoldenPath("http-json");
  assert.deepEqual(http, local);
  assert.deepEqual(local, {
    task: "done",
    assignment: "closed",
    session: "closed",
    lease: "released",
    callbackOutcome: "partial",
    callbackCreatedVerification: false,
    repositoryChanged: true,
    verificationGates: ["acceptance", "test"],
    verifierDistinctFromWorker: true,
    boardWorkerState: "archived",
    restartBoardEquivalent: true,
    replayCreatedEvents: false,
  });
});

test("both adapter transports fail closed on timeout", async () => {
  const local = await runTimeout("local-process");
  const http = await runTimeout("http-json");
  assert.deepEqual(http, local);
  assert.deepEqual(local, {
    callback: "absent",
    timedOut: true,
    failureReason: "TimedOut",
    assignment: "failed",
    task: "blocked",
    verificationCount: 0,
  });
});

test("LPS rejects transport isolation drift before Assignment creation", async () => {
  const { runtime } = await project("isolation-drift");
  try {
    const steward = new StewardService(runtime);
    const intake = await steward.apply(steward.prepare("Reject transport isolation drift"));
    const agent = await runtime.registerAgent("isolation-drift-worker", "http-json");
    const agentId = ((agent.value as JsonObject).metadata as JsonObject).id as string;
    const provider = new HttpJsonAdapter({
      endpoint: "http://127.0.0.1:9/provider",
      binding: {
        id: LOCAL_PROCESS_ADAPTER_CONTRACT.id,
        version: LOCAL_PROCESS_ADAPTER_CONTRACT.version,
        capabilities: [...LOCAL_PROCESS_ADAPTER_CONTRACT.capabilities],
      },
    });
    const before = runtime.status().stateDigest;
    await assert.rejects(
      new LpsOrchestrator(runtime, provider).executeLane(intake.taskId as string, agentId),
      (error: unknown) => error instanceof PkrError &&
        error.code === "PKR-COORD-005" &&
        error.message.includes("isolation does not match"),
    );
    assert.equal(runtime.status().stateDigest, before);
    assert.equal(runtime.listRecords("Assignment").length, 0);
  } finally {
    runtime.close();
  }
});

test("expired Leases reject late callbacks from both adapter transports", async () => {
  const local = await runLateCallbackRejection("local-process");
  const http = await runLateCallbackRejection("http-json");
  assert.deepEqual(http, local);
  assert.deepEqual(local, {
    assignment: "expired",
    lease: "expired",
    session: "expired",
    task: "blocked",
    lateCallbackPersisted: false,
  });
});

async function runGoldenPath(kind: AdapterKind): Promise<GoldenPathSemantics> {
  const { root, runtime } = await project(`conformance-${kind}`);
  let runtimeClosed = false;
  const outputFile = `provider-${kind}.txt`;
  const harness = await adapterHarness(kind, outputFile, 0, 10_000);
  try {
    const binding = runtime.inspectProviderAdapterBinding({
      id: harness.adapter.id,
      version: harness.adapter.version,
      capabilities: [...harness.adapter.capabilities],
    });
    assert.equal(binding.id, harness.adapter.id);
    assert.equal(binding.version, harness.adapter.version);
    assert.deepEqual(binding.capabilities, [...harness.adapter.capabilities]);
    assert.deepEqual(binding.isolation, harness.adapter.isolation);
    const beforeBadBinding = runtime.status().stateDigest;
    assert.throws(
      () => runtime.inspectProviderAdapterBinding({
        id: harness.adapter.id,
        version: "999.0.0",
        capabilities: [...harness.adapter.capabilities],
      }),
      (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-012",
    );
    assert.equal(runtime.status().stateDigest, beforeBadBinding);

    const steward = new StewardService(runtime);
    const intake = await steward.apply(
      steward.prepare(`Conformance replay through ${kind}`),
    );
    const agent = await runtime.registerAgent(`${kind}-worker`, kind);
    const agentId = ((agent.value as JsonObject).metadata as JsonObject).id as string;
    const lps = new LpsOrchestrator(runtime, harness.adapter);
    const result = await lps.executeLane(intake.taskId as string, agentId);
    assert.equal(result.callback?.outcome, "partial");
    assert.equal(result.process?.failureReason, null);
    assert.equal(result.process?.exitCode, 0);
    assert.deepEqual(Object.keys(result.process?.extensions ?? {}), [harness.transportExtension]);
    assert.equal(runtime.listRecords("Verification").length, 0);

    const assignment = runtime.getRecord("Assignment", result.assignmentId);
    const session = runtime.getRecord("AgentSession", result.sessionId);
    const lease = runtime.getRecord("Lease", result.leaseId);
    const task = runtime.getRecord("Task", intake.taskId as string);
    assert.equal(assignment.data.state, "submitted");
    assert.equal(session.data.state, "closing");
    assert.equal(lease.data.state, "released");
    assert.equal((task.data.status as JsonObject).phase, "verifying");
    assert.deepEqual(session.data.adapter, { id: harness.adapter.id, version: harness.adapter.version });

    const providerMessage = runtime.listRecords("AgentMessage").find(
      (record) => record.data.assignmentId === result.assignmentId,
    );
    assert.ok(providerMessage);
    const messageExtensions = providerMessage.data.extensions as JsonObject;
    const processEvidence = messageExtensions["pkr.provider/process"] as JsonObject;
    const transportExtensions = processEvidence.extensions as JsonObject;
    assert.deepEqual(Object.keys(transportExtensions), [harness.transportExtension]);
    assert.equal(JSON.stringify(processEvidence).includes("fake-private-header-value"), false);
    const workspaceEvidence = messageExtensions["pkr.workspace/evidence"] as JsonObject;
    const baseline = workspaceEvidence.baseline as JsonObject;
    const current = workspaceEvidence.current as JsonObject;
    assert.deepEqual(baseline.changedFiles, []);
    assert.equal((current.changedFiles as string[]).includes(outputFile), true);

    const verificationEvidence = await runLocalVerification(
      root,
      intake.taskId as string,
      result.assignmentId,
      verificationPlan([outputFile]),
    );
    await assert.rejects(
      runtime.verify(
        intake.taskId as string,
        result.assignmentId,
        agentId,
        `command_${kind}_self_verify`,
        verificationEvidence,
      ),
      (error: unknown) => error instanceof PkrError && error.code === "PKR-VERIFY-002",
    );
    const accepted = await runtime.verify(
      intake.taskId as string,
      result.assignmentId,
      "agent_independent_verifier",
      `command_${kind}_independent_verify`,
      verificationEvidence,
    );
    assert.equal((accepted.value as JsonObject).passed, true);

    const board = lps.board();
    const eventCount = runtime.listEvents().length;
    const verificationGates = runtime.listRecords("Verification")
      .map((record) => ((record.data.spec as JsonObject).gate as string))
      .sort();
    runtime.close();
    runtimeClosed = true;
    await harness.close();

    const reopened = await PkrRuntime.open(root, repositoryRoot);
    const replayHarness = await adapterHarness(kind, outputFile, 0, 10_000, true);
    try {
      const reopenedLps = new LpsOrchestrator(reopened, replayHarness.adapter);
      const rebuiltBoard = reopenedLps.board();
      const replayed = await reopenedLps.executeLane(intake.taskId as string, agentId);
      const semantics: GoldenPathSemantics = {
        task: ((reopened.getRecord("Task", intake.taskId as string).data.status as JsonObject).phase as string),
        assignment: reopened.getRecord("Assignment", result.assignmentId).data.state as string,
        session: reopened.getRecord("AgentSession", result.sessionId).data.state as string,
        lease: reopened.getRecord("Lease", result.leaseId).data.state as string,
        callbackOutcome: result.callback!.outcome,
        callbackCreatedVerification: false,
        repositoryChanged: (current.changedFiles as string[]).includes(outputFile),
        verificationGates,
        verifierDistinctFromWorker: agentId !== "agent_independent_verifier",
        boardWorkerState: ((rebuiltBoard.workers as JsonObject[])[0]!.state as string),
        restartBoardEquivalent: JSON.stringify(rebuiltBoard) === JSON.stringify(board),
        replayCreatedEvents: reopened.listEvents().length !== eventCount || !replayed.reused,
      };
      reopened.close();
      return semantics;
    } finally {
      await replayHarness.close();
    }
  } finally {
    if (!runtimeClosed) {
      runtime.close();
    }
    await harness.close();
  }
}

async function runTimeout(kind: AdapterKind): Promise<TimeoutSemantics> {
  const { runtime } = await project(`timeout-${kind}`);
  const harness = await adapterHarness(kind, `timeout-${kind}.txt`, 100, 10, false);
  try {
    const steward = new StewardService(runtime);
    const intake = await steward.apply(steward.prepare(`Timeout ${kind}`));
    const agent = await runtime.registerAgent(`${kind}-timeout-worker`, kind);
    const agentId = ((agent.value as JsonObject).metadata as JsonObject).id as string;
    const result = await new LpsOrchestrator(runtime, harness.adapter).executeLane(
      intake.taskId as string,
      agentId,
    );
    const assignment = runtime.listRecords("Assignment").find(
      (record) => record.data.taskId === intake.taskId,
    )!;
    return {
      callback: result.callback ? "present" : "absent",
      timedOut: result.process?.timedOut ?? false,
      failureReason: result.process?.failureReason ?? null,
      assignment: assignment.data.state as string,
      task: (runtime.getRecord("Task", intake.taskId as string).data.status as JsonObject).phase as string,
      verificationCount: runtime.listRecords("Verification").length,
    };
  } finally {
    runtime.close();
    await harness.close();
  }
}

async function runLateCallbackRejection(kind: AdapterKind): Promise<RevocationSemantics> {
  const { root, runtime } = await project(`revocation-${kind}`);
  const harness = await adapterHarness(kind, `revocation-${kind}.txt`, 0, 10_000, false);
  try {
    const steward = new StewardService(runtime);
    const intake = await steward.apply(steward.prepare(`Late callback ${kind}`));
    const agent = await runtime.registerAgent(`${kind}-revoked-worker`, kind);
    const agentId = ((agent.value as JsonObject).metadata as JsonObject).id as string;
    const dispatch = await runtime.dispatch(
      intake.taskId as string,
      agentId,
      `command_${kind}_revoked_dispatch`,
      {
        executionMode: "adapter",
        providerBinding: {
          id: harness.adapter.id,
          version: harness.adapter.version,
          capabilities: [...harness.adapter.capabilities],
        },
      },
    );
    const value = dispatch.value as JsonObject;
    const assignmentId = value.assignmentId as string;
    const sessionId = value.sessionId as string;
    const leaseId = value.leaseId as string;
    const repository = await collectRepositoryEvidence(root);
    const workspace = runtime.workspace(
      intake.taskId as string,
      assignmentId,
      agentId,
      repository as unknown as JsonObject,
    );
    const beforeUnnamespacedCallback = runtime.status().stateDigest;
    await assert.rejects(
      runtime.callback(
        assignmentId,
        "partial",
        [],
        `command_${kind}_unnamespaced_callback`,
        {
          ...callback(`revocation-${kind}.txt`) as unknown as JsonObject,
          providerTraceId: "trace_fake_001",
        },
      ),
      (error: unknown) => error instanceof PkrError && error.code === "PKR-COORD-008",
    );
    assert.equal(runtime.status().stateDigest, beforeUnnamespacedCallback);
    await runtime.expireLease(leaseId, `command_${kind}_expire`);
    const execution = await harness.adapter.execute({ assignmentId, sessionId, workspace });
    assert.ok(execution.callback);
    const messageCount = runtime.listRecords("AgentMessage").length;
    await assert.rejects(
      runtime.callback(
        assignmentId,
        execution.callback.outcome,
        execution.callback.evidenceIds,
        `command_${kind}_late_callback`,
        execution.callback as unknown as JsonObject,
        execution.process as unknown as JsonObject,
        { baseline: repository as unknown as JsonObject, current: repository as unknown as JsonObject },
      ),
      (error: unknown) => error instanceof PkrError && error.code === "PKR-COORD-008",
    );
    return {
      assignment: runtime.getRecord("Assignment", assignmentId).data.state as string,
      lease: runtime.getRecord("Lease", leaseId).data.state as string,
      session: runtime.getRecord("AgentSession", sessionId).data.state as string,
      task: (runtime.getRecord("Task", intake.taskId as string).data.status as JsonObject).phase as string,
      lateCallbackPersisted: runtime.listRecords("AgentMessage").length !== messageCount,
    };
  } finally {
    runtime.close();
    await harness.close();
  }
}

async function adapterHarness(
  kind: AdapterKind,
  outputFile: string,
  delayMs: number,
  timeoutMs: number,
  failIfCalled = false,
): Promise<AdapterHarness> {
  if (kind === "local-process") {
    const environment: NodeJS.ProcessEnv = {
      ...(delayMs ? { PKR_PROVIDER_DELAY_MS: String(delayMs) } : {}),
      ...(!failIfCalled && delayMs === 0 && outputFile.startsWith("provider-")
        ? { PKR_PROVIDER_WRITE_FILE: outputFile }
        : {}),
    };
    return {
      adapter: new LocalProcessAdapter(process.execPath, workerScript, timeoutMs, environment),
      outputFile,
      transportExtension: "pkr.adapter.local-process/transport",
      close: async () => undefined,
    };
  }
  const fake = await startFakeHttpProvider({ outputFile, delayMs, failIfCalled });
  return {
    adapter: new HttpJsonAdapter({
      endpoint: fake.endpoint,
      timeoutMs,
      headers: { "x-provider-conformance": "fake-private-header-value" },
    }),
    outputFile,
    transportExtension: "pkr.adapter.http-json/transport",
    close: fake.close,
  };
}

async function startFakeHttpProvider(options: {
  outputFile: string;
  delayMs: number;
  failIfCalled: boolean;
}): Promise<{ endpoint: string; close(): Promise<void> }> {
  let closed = false;
  const server = createServer(async (request, response) => {
    response.on("error", () => undefined);
    if (options.failIfCalled) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "adapter should have reused closed state" }));
      return;
    }
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString();
    }
    const execution = JSON.parse(body) as {
      workspace: { extensions: Record<string, JsonObject> };
    };
    if (options.delayMs) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, options.delayMs));
    } else if (options.outputFile.includes("provider-")) {
      const repository = execution.workspace.extensions["pkr.workspace/repository"];
      assert.ok(repository);
      await writeFile(
        join(repository.repositoryRoot as string, options.outputFile),
        `fake HTTP provider result\n`,
        "utf8",
      );
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(callback(options.outputFile)));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}/provider`,
    close: async () => {
      if (closed || !server.listening) {
        return;
      }
      closed = true;
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      const index = servers.indexOf(server);
      if (index >= 0) {
        servers.splice(index, 1);
      }
    },
  };
}

function callback(outputFile: string): ProviderCallback {
  return {
    outcome: "partial",
    completed: ["provider-result-produced"],
    incomplete: ["repository-verification", "acceptance"],
    blockers: [],
    evidenceIds: [],
    outputs: [{ kind: "patch", locator: outputFile }],
    nextAction: "collect repository evidence and run the independent Verifier",
  };
}

async function project(name: string): Promise<{ root: string; runtime: PkrRuntime }> {
  const root = await mkdtemp(join(tmpdir(), `pkr-${name}-`));
  temporaryRoots.push(root);
  const initialized = spawnSync("git", ["init", "-b", "main"], { cwd: root, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  await writeFile(join(root, ".gitignore"), ".pkr/\n", "utf8");
  await writeFile(join(root, "README.md"), "# Provider conformance fixture\n", "utf8");
  assert.equal(spawnSync("git", ["add", "."], { cwd: root }).status, 0);
  const committed = spawnSync(
    "git",
    ["-c", "user.name=PKR Test", "-c", "user.email=pkr@example.invalid", "commit", "-m", "baseline"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(committed.status, 0, committed.stderr);
  return {
    root,
    runtime: await PkrRuntime.init(root, repositoryRoot, {
      name,
      title: name,
      outcome: `Prove ${name}.`,
    }),
  };
}

function verificationPlan(allowedPaths: string[]): VerificationPlan {
  return {
    version: "pkr.verify/v1",
    commands: [{
      id: "provider-conformance-check",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 10_000,
    }],
    allowedPaths,
    forbiddenPaths: [".pkr/**"],
    requireChanges: true,
  };
}
