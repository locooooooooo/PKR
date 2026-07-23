import { PkrError } from "./errors.js";
import type {
  AgentProviderAdapter,
  ProviderCallback,
  ProviderExecutionResult,
  ProviderOutputDeclaration,
} from "./provider.js";
import type { PkrRuntime } from "./runtime.js";
import { isBoundedCallbackPayload, isSafeOutputLocator } from "./security.js";
import type { JsonObject, StoredRecord } from "./types.js";
import { derivedId, digest } from "./util.js";
import { collectRepositoryEvidence } from "./workspace.js";

const TERMINAL_ASSIGNMENTS = new Set([
  "closed",
  "rejected",
  "cancelled",
  "expired",
  "failed",
]);

export interface LpsExecutionResult {
  assignmentId: string;
  sessionId: string;
  leaseId: string;
  taskId: string;
  callback?: ProviderCallback;
  process?: ProviderExecutionResult["process"];
  reused: boolean;
  board: JsonObject;
}

export interface AgentNativeSubmission {
  outcome: "verified" | "partial" | "blocked" | "externalSignoffBlocked";
  completed: string[];
  incomplete: string[];
  blockers: string[];
  evidenceIds: string[];
  outputs: ProviderOutputDeclaration[];
  nextAction: string;
}

export interface LpsClaimResult {
  assignmentId: string;
  sessionId: string;
  leaseId: string;
  taskId: string;
  workspace: JsonObject;
  reused: boolean;
  board: JsonObject;
}

export interface LpsSubmitResult {
  assignmentId: string;
  taskId: string;
  outcome: AgentNativeSubmission["outcome"];
  repository: JsonObject;
  reused: boolean;
  board: JsonObject;
}

export class LpsOrchestrator {
  constructor(
    private readonly runtime: PkrRuntime,
    private readonly provider?: AgentProviderAdapter,
  ) {}

  board(): JsonObject {
    const status = this.runtime.status();
    const sessions = new Map(
      this.runtime.listRecords("AgentSession").map((record) => [record.id, record]),
    );
    const leases = this.runtime.listRecords("Lease");
    const workers = this.runtime.listRecords("Assignment").map((assignment) => {
      const lease = leases.find(
        (candidate) => candidate.data.assignmentId === assignment.id,
      );
      const session = lease
        ? sessions.get(lease.data.sessionId as string)
        : undefined;
      return {
        identity: `[Worker]#${assignment.id}@${assignment.revision}`,
        thread_id: session ? (session.data.sessionLocator as string) : null,
        role: "short-worker",
        module: assignment.data.taskId as string,
        state: workerState(assignment),
        task_tag: `pkr:task:${assignment.data.taskId as string}`,
        session_tag: session ? `pkr:session:${session.id}` : null,
        current_gate:
          assignment.data.state === "running"
            ? "execution"
            : assignment.data.state === "submitted" ? "verification" : null,
        assignment_id: assignment.id,
        lease_id: lease?.id ?? null,
        last_verified_activity: assignment.updatedAt,
      };
    });
    const active = workers.find((worker) => worker.state === "active");
    return {
      schema_version: 2,
      source: {
        authority: "PKR",
        projectId: this.runtime.projectId,
        projectSequence: status.projectSequence as number,
      },
      loop_state: active ? "active" : "summarized",
      dispatch_state: active ? "dispatching" : "standby",
      delivery_state: active ? "implementing" : "planned",
      assurance_state: workers.some((worker) => worker.state === "archived")
        ? "verified"
        : "unassessed",
      active_gate: active
        ? {
            assignment_id: active.assignment_id,
            session_tag: active.session_tag,
            gate: active.current_gate,
          }
        : null,
      workers,
      blockers: [],
    };
  }

  async claim(
    taskId: string,
    agentId: string,
    sessionLocator?: string,
  ): Promise<LpsClaimResult> {
    await this.runtime.recoverInterruptedSessions();
    const assignments = this.runtime
      .listRecords("Assignment")
      .filter((record) => record.data.taskId === taskId);
    const existing = assignments.find((record) =>
      ["offered", "accepted", "running", "submitted"].includes(record.data.state as string),
    );
    const expired = assignments
      .filter((record) => record.data.state === "expired")
      .sort((left, right) =>
        (right.data.projectSequence as number) - (left.data.projectSequence as number),
      )[0];
    let assignmentId: string;
    let sessionId: string;
    let leaseId: string;
    let reused = false;
    if (existing) {
      if (existing.data.state !== "running") {
        throw new PkrError(
          "PKR-COORD-006",
          `Task Assignment ${existing.id} is ${existing.data.state as string}; it cannot be claimed for work`,
        );
      }
      const lease = this.relatedLease(existing);
      if (lease.data.agentId !== agentId) {
        throw new PkrError("PKR-COORD-005", `Assignment ${existing.id} is leased to another Agent`);
      }
      const session = this.relatedSession(existing);
      const native = (session.data.extensions as JsonObject)["pkr.agent-native/session"] as JsonObject | undefined;
      if (native?.mode !== "pull") {
        throw new PkrError("PKR-COORD-006", `Assignment ${existing.id} belongs to an Adapter execution lane`);
      }
      assignmentId = existing.id;
      sessionId = session.id;
      leaseId = lease.id;
      reused = true;
    } else {
      const baseline = await collectRepositoryEvidence(this.runtime.paths.root);
      const dispatch = await this.runtime.dispatch(
        taskId,
        agentId,
        derivedId(
          "command",
          `lps-agent-native:${this.runtime.projectId}:${taskId}:${agentId}:claim` +
            (expired ? `:reassign:${expired.id}` : ""),
        ),
        {
          executionMode: "agent-native",
          ...(sessionLocator ? { sessionLocator } : {}),
          repositoryBaseline: baseline as unknown as JsonObject,
          ...(expired ? { recoveryFromAssignmentId: expired.id } : {}),
        },
      );
      const value = dispatch.value as JsonObject;
      assignmentId = value.assignmentId as string;
      sessionId = value.sessionId as string;
      leaseId = value.leaseId as string;
    }
    const current = await collectRepositoryEvidence(this.runtime.paths.root);
    const workspace = this.runtime.workspace(
      taskId,
      assignmentId,
      agentId,
      current as unknown as JsonObject,
    );
    return {
      assignmentId,
      sessionId,
      leaseId,
      taskId,
      workspace,
      reused,
      board: this.board(),
    };
  }

  async submit(
    assignmentId: string,
    agentId: string,
    submission?: Partial<AgentNativeSubmission>,
  ): Promise<LpsSubmitResult> {
    await this.runtime.recoverInterruptedSessions();
    const assignment = this.runtime.getRecord("Assignment", assignmentId);
    const taskId = assignment.data.taskId as string;
    const lease = this.relatedLease(assignment);
    if (lease.data.agentId !== agentId) {
      throw new PkrError("PKR-COORD-005", `Assignment ${assignmentId} is leased to another Agent`);
    }
    const session = this.relatedSession(assignment);
    const native = (session.data.extensions as JsonObject)["pkr.agent-native/session"] as JsonObject | undefined;
    if (native?.mode !== "pull") {
      throw new PkrError("PKR-COORD-008", "Agent-native submit cannot submit an Adapter execution lane");
    }
    if (assignment.data.state === "submitted") {
      return {
        assignmentId,
        taskId,
        outcome: assignment.data.disposition as AgentNativeSubmission["outcome"],
        repository: await collectRepositoryEvidence(this.runtime.paths.root) as unknown as JsonObject,
        reused: true,
        board: this.board(),
      };
    }
    if (assignment.data.state !== "running") {
      throw new PkrError("PKR-COORD-008", "Agent-native submit requires a running Assignment");
    }
    const baseline = native?.repositoryBaseline;
    if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
      throw new PkrError("PKR-COORD-008", "Agent-native submit requires its persisted claim baseline");
    }
    const baselineEvidence = baseline.refVersion === "pkr.repository-evidence-ref/v1"
      ? this.runtime.resolveRepositoryEvidence(baseline as JsonObject)
      : baseline as JsonObject;
    const callback = normalizeAgentNativeSubmission(submission);
    const current = await collectRepositoryEvidence(this.runtime.paths.root);
    const workspaceEvidence: JsonObject = {
      baseline: baseline as JsonObject,
      current: current as unknown as JsonObject,
    };
    await this.runtime.callback(
      assignmentId,
      callback.outcome,
      callback.evidenceIds,
      derivedId("command", `lps-agent-native:${assignmentId}:submit:${digest({
        callback,
        baselineDigest: baselineEvidence.contentDigest ?? null,
        currentDigest: current.contentDigest,
      })}`),
      callback as unknown as JsonObject,
      undefined,
      workspaceEvidence,
    );
    return {
      assignmentId,
      taskId,
      outcome: callback.outcome,
      repository: current as unknown as JsonObject,
      reused: false,
      board: this.board(),
    };
  }

  async executeLane(taskId: string, agentId: string): Promise<LpsExecutionResult> {
    if (!this.provider) {
      throw new PkrError("PKR-PROVIDER-001", "optional Adapter execution requires a configured Provider");
    }
    await this.runtime.recoverInterruptedSessions();
    this.assertCapabilities(["filesystem.read", "filesystem.write", "terminal"]);
    const assignments = this.runtime
      .listRecords("Assignment")
      .filter((record) => record.data.taskId === taskId);
    const existing = assignments.find((record) =>
      ["offered", "accepted", "running", "submitted"].includes(record.data.state as string),
    ) ?? assignments.find((record) => record.data.state === "closed");
    const expired = assignments
      .filter((record) => record.data.state === "expired")
      .sort((left, right) =>
        (right.data.projectSequence as number) - (left.data.projectSequence as number),
      )[0];
    if (existing && existing.data.state === "closed") {
      return {
        assignmentId: existing.id,
        sessionId: this.relatedSession(existing).id,
        leaseId: this.relatedLease(existing).id,
        taskId,
        reused: true,
        board: this.board(),
      };
    }
    if (existing && TERMINAL_ASSIGNMENTS.has(existing.data.state as string)) {
      throw new PkrError(
        "PKR-COORD-006",
        `Task has terminal Assignment ${existing.id}; create a replacement Task or recovery Decision`,
      );
    }

    let assignmentId: string;
    let sessionId: string;
    let leaseId: string;
    if (existing) {
      assignmentId = existing.id;
      const lease = this.relatedLease(existing);
      leaseId = lease.id;
      sessionId = this.relatedSession(existing).id;
    } else {
      const dispatchCommand = derivedId(
        "command",
        `lps:${this.runtime.projectId}:${taskId}:${agentId}:dispatch` +
          (expired ? `:reassign:${expired.id}` : ""),
      );
      const dispatch = await this.runtime.dispatch(
        taskId,
        agentId,
        dispatchCommand,
        {
          executionMode: "adapter",
          providerBinding: {
            id: this.provider.id,
            version: this.provider.version,
            capabilities: [...this.provider.capabilities],
          },
          ...(expired ? { recoveryFromAssignmentId: expired.id } : {}),
        },
      );
      const value = dispatch.value as JsonObject;
      assignmentId = value.assignmentId as string;
      sessionId = value.sessionId as string;
      leaseId = value.leaseId as string;
    }

    const assignment = this.runtime.getRecord("Assignment", assignmentId);
    if (assignment.data.state === "submitted") {
      return {
        assignmentId,
        sessionId,
        leaseId,
        taskId,
        reused: true,
        board: this.board(),
      };
    }

    const baseline = await collectRepositoryEvidence(this.runtime.paths.root);
    const workspace = this.runtime.workspace(
      taskId,
      assignmentId,
      agentId,
      baseline as unknown as JsonObject,
    );
    const providerRequest = {
      assignmentId,
      sessionId,
      workspace,
    };
    const effectId = derivedId("effect", `provider:${assignmentId}:execute`);
    const priorEffect = this.runtime.externalEffect(effectId);
    const effect = priorEffect
      ? { ...priorEffect, execute: false }
      : this.runtime.beginExternalEffect(
          assignmentId,
          effectId,
          providerRequest as unknown as JsonObject,
        );
    if (!effect.execute && effect.state === "pending") {
      throw new PkrError(
        "PKR-RECOVERY-003",
        `Provider effect ${effectId} has an unknown outcome and requires reconciliation`,
      );
    }
    let execution: ProviderExecutionResult;
    let workspaceEvidence: JsonObject;
    if (effect.execute) {
      execution = await this.provider.execute(providerRequest);
      if (process.env.PKR_FAILPOINT === "after-provider-execute") {
        throw new Error("PKR failpoint after-provider-execute");
      }
      const current = await collectRepositoryEvidence(this.runtime.paths.root);
      workspaceEvidence = {
        baseline: baseline as unknown as JsonObject,
        current: current as unknown as JsonObject,
      };
      this.runtime.completeExternalEffect(
        effectId,
        "succeeded",
        { execution: execution as unknown as JsonObject, workspaceEvidence },
      );
    } else {
      const retained = effect.result as JsonObject | undefined;
      if (!retained?.execution || !retained.workspaceEvidence) {
        throw new PkrError("PKR-RECOVERY-003", `Provider effect ${effectId} has no replayable result`);
      }
      execution = retained.execution as unknown as ProviderExecutionResult;
      workspaceEvidence = retained.workspaceEvidence as JsonObject;
    }
    if (process.env.PKR_FAILPOINT === "after-provider-effect") {
      throw new Error("PKR failpoint after-provider-effect");
    }
    if (execution.callback) {
      await this.runtime.callback(
        assignmentId,
        execution.callback.outcome,
        execution.callback.evidenceIds,
        derivedId("command", `lps:${assignmentId}:callback`),
        execution.callback as unknown as JsonObject,
        execution.process as unknown as JsonObject,
        workspaceEvidence,
      );
    } else {
      await this.runtime.recordProviderFailure(
        assignmentId,
        execution.process as unknown as JsonObject,
        workspaceEvidence,
        derivedId("command", `lps:${assignmentId}:provider-failure`),
      );
    }
    return {
      assignmentId,
      sessionId,
      leaseId,
      taskId,
      ...(execution.callback ? { callback: execution.callback } : {}),
      process: execution.process,
      reused: false,
      board: this.board(),
    };
  }

  async cancel(assignmentId: string, reason: string): Promise<JsonObject> {
    const result = await this.runtime.cancelAssignment(
      assignmentId,
      reason,
      derivedId("command", `lps:${assignmentId}:cancel:${reason}`),
    );
    return result.value as JsonObject;
  }

  async heartbeat(assignmentId: string): Promise<JsonObject> {
    const assignment = this.runtime.getRecord("Assignment", assignmentId);
    const lease = this.relatedLease(assignment);
    const session = this.relatedSession(assignment);
    const result = await this.runtime.heartbeat(
      session.id,
      lease.id,
      derivedId("command", `lps:${assignmentId}:heartbeat:${lease.revision}`),
    );
    return result.value as JsonObject;
  }

  async expire(assignmentId: string): Promise<JsonObject> {
    const assignment = this.runtime.getRecord("Assignment", assignmentId);
    const lease = this.relatedLease(assignment);
    const result = await this.runtime.expireLease(
      lease.id,
      derivedId("command", `lps:${assignmentId}:expire`),
    );
    return result.value as JsonObject;
  }

  private assertCapabilities(required: string[]): void {
    if (!this.provider) {
      throw new PkrError("PKR-PROVIDER-001", "optional Adapter execution requires a configured Provider");
    }
    const binding = this.runtime.inspectProviderAdapterBinding({
      id: this.provider.id,
      version: this.provider.version,
      capabilities: [...this.provider.capabilities],
    });
    if (JSON.stringify(binding.isolation) !== JSON.stringify(this.provider.isolation)) {
      throw new PkrError(
        "PKR-COORD-005",
        `provider ${this.provider.id}@${this.provider.version} isolation does not match its Runtime binding`,
      );
    }
    const available = new Set(binding.capabilities as string[]);
    const missing = required.filter((capability) => !available.has(capability));
    if (missing.length) {
      throw new PkrError(
        "PKR-COORD-005",
        `provider ${this.provider.id} lacks capabilities: ${missing.join(", ")}`,
      );
    }
  }

  private relatedLease(assignment: StoredRecord): StoredRecord {
    const lease = this.runtime
      .listRecords("Lease")
      .find((record) => record.data.assignmentId === assignment.id);
    if (!lease) {
      throw new PkrError("PKR-COORD-006", `Assignment ${assignment.id} has no Lease`);
    }
    return lease;
  }

  private relatedSession(assignment: StoredRecord): StoredRecord {
    const lease = this.relatedLease(assignment);
    return this.runtime.getRecord("AgentSession", lease.data.sessionId as string);
  }
}

function workerState(assignment: StoredRecord): string {
  switch (assignment.data.state) {
    case "running":
      return "active";
    case "submitted":
      return "waiting_verification";
    case "closed":
      return "archived";
    case "blocked":
    case "expired":
    case "failed":
      return "blocked";
    case "cancelled":
    case "rejected":
      return "archived";
    default:
      return "active";
  }
}

function normalizeAgentNativeSubmission(
  input?: Partial<AgentNativeSubmission>,
): AgentNativeSubmission {
  const submission: AgentNativeSubmission = {
    outcome: input?.outcome ?? "partial",
    completed: input?.completed ?? [],
    incomplete: input?.incomplete ?? ["independent-verification", "acceptance"],
    blockers: input?.blockers ?? [],
    evidenceIds: input?.evidenceIds ?? [],
    outputs: input?.outputs ?? [],
    nextAction: input?.nextAction ?? "Run independent repository Verification.",
  };
  const stringLists = [
    submission.completed,
    submission.incomplete,
    submission.blockers,
    submission.evidenceIds,
  ];
  if (
    !isBoundedCallbackPayload(submission as unknown) ||
    !["verified", "partial", "blocked", "externalSignoffBlocked"].includes(submission.outcome) ||
    stringLists.some((values) => !Array.isArray(values) || values.some((value) => typeof value !== "string")) ||
    !Array.isArray(submission.outputs) ||
    submission.outputs.some((output) =>
      !output ||
      !["proposal", "result", "patch", "log", "artifact"].includes(output.kind) ||
      !isSafeOutputLocator(output.locator)
    ) ||
    typeof submission.nextAction !== "string"
  ) {
    throw new PkrError("PKR-COORD-008", "Agent-native submission has an invalid callback shape");
  }
  return submission;
}
