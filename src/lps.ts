import { PkrError } from "./errors.js";
import type { AgentProviderAdapter, ProviderCallback } from "./provider.js";
import type { PkrRuntime } from "./runtime.js";
import type { JsonObject, StoredRecord } from "./types.js";
import { derivedId } from "./util.js";

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
  reused: boolean;
  board: JsonObject;
}

export class LpsOrchestrator {
  constructor(
    private readonly runtime: PkrRuntime,
    private readonly provider: AgentProviderAdapter,
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
        thread_id: session ? (session.data.providerLocator as string) : null,
        role: "short-worker",
        module: assignment.data.taskId as string,
        state: workerState(assignment),
        task_tag: `pkr:task:${assignment.data.taskId as string}`,
        session_tag: session ? `pkr:session:${session.id}` : null,
        current_gate:
          assignment.data.state === "running" ? "execution" : null,
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

  async executeLane(taskId: string, agentId: string): Promise<LpsExecutionResult> {
    this.assertCapabilities(["filesystem.read", "filesystem.write", "terminal"]);
    const existing = this.runtime
      .listRecords("Assignment")
      .find((record) => record.data.taskId === taskId);
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
        `lps:${this.runtime.projectId}:${taskId}:${agentId}:dispatch`,
      );
      const dispatch = await this.runtime.dispatch(taskId, agentId, dispatchCommand);
      const value = dispatch.value as JsonObject;
      assignmentId = value.assignmentId as string;
      sessionId = value.sessionId as string;
      leaseId = value.leaseId as string;
    }

    const assignment = this.runtime.getRecord("Assignment", assignmentId);
    if (assignment.data.state === "submitted") {
      const outcome = assignment.data.disposition as string;
      if (outcome === "verified") {
        await this.runtime.verify(
          taskId,
          assignmentId,
          "agent_verifier",
          derivedId("command", `lps:${assignmentId}:verify`),
        );
      }
      return {
        assignmentId,
        sessionId,
        leaseId,
        taskId,
        reused: true,
        board: this.board(),
      };
    }

    const workspace = this.runtime.workspace(taskId, assignmentId, agentId);
    const callback = await this.provider.execute({
      assignmentId,
      sessionId,
      workspace,
    });
    await this.runtime.callback(
      assignmentId,
      callback.outcome,
      callback.evidenceIds,
      derivedId("command", `lps:${assignmentId}:callback`),
      {
        completed: callback.completed,
        incomplete: callback.incomplete,
        blockers: callback.blockers,
        nextAction: callback.nextAction,
      },
    );
    if (callback.outcome === "verified") {
      await this.runtime.verify(
        taskId,
        assignmentId,
        "agent_verifier",
        derivedId("command", `lps:${assignmentId}:verify`),
      );
    }
    return {
      assignmentId,
      sessionId,
      leaseId,
      taskId,
      callback,
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
    const available = new Set(this.provider.capabilities);
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
      return assignment.data.disposition === "verified" ? "waiting_callback" : "blocked";
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
