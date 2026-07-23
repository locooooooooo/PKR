import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { PkrError } from "./errors.js";
import { LpsOrchestrator } from "./lps.js";
import {
  loadLocalProviderConfig,
  type AgentProviderAdapter,
} from "./provider.js";
import type { PkrRuntime } from "./runtime.js";
import type { JsonObject, StoredRecord } from "./types.js";
import { derivedId, digest } from "./util.js";
import {
  loadVerificationPlan,
  runLocalVerification,
  type VerificationPlan,
} from "./verifier.js";

export type SupervisorAction =
  | "dispatch"
  | "dispatch_recovery"
  | "execute"
  | "absorb_provider_result"
  | "heartbeat"
  | "expire_lease"
  | "verify"
  | "noop"
  | "owner_attention";

export type SupervisorAttentionCode =
  | "TaskNotFound"
  | "TaskBlocked"
  | "ProtectedDecisionRequired"
  | "ClarificationRequired"
  | "MissingAgentConfiguration"
  | "AgentNotFound"
  | "AgentNotActive"
  | "MissingProviderConfiguration"
  | "InvalidProviderConfiguration"
  | "MissingProviderCapability"
  | "MissingVerificationConfiguration"
  | "InvalidVerificationConfiguration"
  | "VerifierNotIndependent"
  | "MissingSkillResolver"
  | "MissingSkillCapability"
  | "AmbiguousExternalEffect"
  | "AmbiguousVerificationEffect"
  | "ProviderReportedBlocked"
  | "RuntimeInvariantViolation"
  | "ReconcileFailed";

export interface SupervisorAttention extends JsonObject {
  code: SupervisorAttentionCode;
  reason: string;
  ownerAttention: boolean;
}

export interface SupervisorSkillRequirement extends JsonObject {
  id: string;
  capabilities: string[];
}

export interface SupervisorSkillMatch extends JsonObject {
  id: string;
  capabilities: string[];
}

export interface SupervisorSkillResolver {
  resolve(
    requirement: SupervisorSkillRequirement,
  ): SupervisorSkillMatch | undefined | Promise<SupervisorSkillMatch | undefined>;
}

export interface SupervisorConfig extends JsonObject {
  version: "pkr.supervisor/v1";
  taskId: string;
  agentId?: string;
  provider?: { file: string };
  verification?: { file: string; actorId: string };
  requiredCapabilities?: string[];
  skillRequirements?: SupervisorSkillRequirement[];
}

export interface SupervisorRecordState extends JsonObject {
  id: string;
  revision: number;
  state: string;
}

export interface SupervisorState extends JsonObject {
  sequence: number;
  task: SupervisorRecordState | null;
  assignment: SupervisorRecordState | null;
}

export interface SupervisorReconcileResult extends JsonObject {
  version: "pkr.supervisor-result/v1";
  observedSequence: number;
  observed: SupervisorState;
  action: SupervisorAction;
  outcome: "advanced" | "noop" | "attention";
  resultState: SupervisorState;
  attention: SupervisorAttention | null;
  nextAction: "reconcile" | "owner_review" | "none";
}

export interface SupervisorDependencies {
  provider?: AgentProviderAdapter;
  verificationPlan?: VerificationPlan;
  skillResolver?: SupervisorSkillResolver;
  configurationIssues?: SupervisorAttention[];
}

const LIVE_ASSIGNMENTS = new Set(["offered", "accepted", "running", "submitted"]);
const TERMINAL_TASKS = new Set(["done", "cancelled"]);
const UNRESOLVED_CLARIFICATIONS = new Set([
  "assessing",
  "question-drafted",
  "awaiting-answers",
  "blocked",
]);

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function configurationError(message: string): PkrError {
  return new PkrError("PKR-SUPERVISOR-001", message);
}

export async function loadSupervisorConfig(path: string): Promise<SupervisorConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    throw configurationError(
      `cannot load Supervisor config ${resolve(path)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!object(parsed)) {
    throw configurationError("Supervisor config must be a JSON object");
  }
  const allowed = new Set([
    "version",
    "taskId",
    "agentId",
    "provider",
    "verification",
    "requiredCapabilities",
    "skillRequirements",
  ]);
  if (Object.keys(parsed).some((key) => !allowed.has(key))) {
    throw configurationError("Supervisor config contains an unknown field");
  }
  if (
    parsed.version !== "pkr.supervisor/v1" ||
    typeof parsed.taskId !== "string" ||
    !parsed.taskId.trim() ||
    (parsed.agentId !== undefined && (typeof parsed.agentId !== "string" || !parsed.agentId.trim())) ||
    (parsed.provider !== undefined &&
      (!object(parsed.provider) || Object.keys(parsed.provider).some((key) => key !== "file") ||
        typeof parsed.provider.file !== "string" || !parsed.provider.file.trim())) ||
    (parsed.verification !== undefined &&
      (!object(parsed.verification) ||
        Object.keys(parsed.verification).some((key) => !["file", "actorId"].includes(key)) ||
        typeof parsed.verification.file !== "string" || !parsed.verification.file.trim() ||
        typeof parsed.verification.actorId !== "string" ||
        !/^[a-z][a-z0-9-]{0,31}_[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(parsed.verification.actorId))) ||
    (parsed.requiredCapabilities !== undefined && !stringList(parsed.requiredCapabilities)) ||
    (parsed.skillRequirements !== undefined &&
      (!Array.isArray(parsed.skillRequirements) ||
        parsed.skillRequirements.some((requirement) =>
          !object(requirement) ||
          Object.keys(requirement).some((key) => !["id", "capabilities"].includes(key)) ||
          typeof requirement.id !== "string" || !requirement.id.trim() ||
          !stringList(requirement.capabilities)
        )))
  ) {
    throw configurationError("Supervisor config has an invalid pkr.supervisor/v1 shape");
  }
  return parsed as unknown as SupervisorConfig;
}

function configuredPath(projectRoot: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
}

function attention(
  code: SupervisorAttentionCode,
  reason: string,
  ownerAttention = false,
): SupervisorAttention {
  return { code, reason, ownerAttention };
}

export class SupervisorRunner {
  private readonly lps: LpsOrchestrator;

  constructor(
    private readonly runtime: PkrRuntime,
    readonly config: SupervisorConfig,
    private readonly dependencies: SupervisorDependencies = {},
  ) {
    this.lps = new LpsOrchestrator(runtime, dependencies.provider);
  }

  static async open(
    runtime: PkrRuntime,
    configPath: string,
    skillResolver?: SupervisorSkillResolver,
  ): Promise<SupervisorRunner> {
    const config = await loadSupervisorConfig(configPath);
    const issues: SupervisorAttention[] = [];
    let provider: AgentProviderAdapter | undefined;
    let verificationPlan: VerificationPlan | undefined;
    if (!config.provider) {
      issues.push(attention(
        "MissingProviderConfiguration",
        "automatic execution requires an explicit Provider Adapter config",
      ));
    } else {
      try {
        provider = await loadLocalProviderConfig(
          configuredPath(runtime.paths.root, config.provider.file),
        );
      } catch (error) {
        issues.push(attention(
          "InvalidProviderConfiguration",
          error instanceof Error ? error.message : String(error),
        ));
      }
    }
    if (!config.verification) {
      issues.push(attention(
        "MissingVerificationConfiguration",
        "automatic completion requires an explicit Verification plan and verifier identity",
      ));
    } else {
      try {
        verificationPlan = await loadVerificationPlan(
          configuredPath(runtime.paths.root, config.verification.file),
        );
      } catch (error) {
        issues.push(attention(
          "InvalidVerificationConfiguration",
          error instanceof Error ? error.message : String(error),
        ));
      }
    }
    return new SupervisorRunner(runtime, config, {
      ...(provider ? { provider } : {}),
      ...(verificationPlan ? { verificationPlan } : {}),
      ...(skillResolver ? { skillResolver } : {}),
      configurationIssues: issues,
    });
  }

  async reconcile(observedAt = new Date().toISOString()): Promise<SupervisorReconcileResult> {
    const observedTime = Date.parse(observedAt);
    if (!Number.isFinite(observedTime)) {
      throw configurationError("Supervisor observation time must be an ISO timestamp");
    }
    const observed = this.readState();
    if (!observed.task) {
      return this.attentionResult(
        observed,
        attention("TaskNotFound", `Task ${this.config.taskId} does not exist in Runtime authority`),
      );
    }
    if (TERMINAL_TASKS.has(observed.task.state)) {
      return this.result(observed, "noop", "noop", null, "none");
    }

    const clarification = this.unresolvedClarification();
    if (clarification) {
      return this.attentionResult(observed, clarification);
    }
    const prerequisite = await this.prerequisiteAttention();
    if (prerequisite) {
      return this.attentionResult(observed, prerequisite);
    }

    const taskPhase = observed.task.state;
    if (taskPhase === "backlog") {
      return this.dispatch(observed);
    }
    if (taskPhase === "inProgress") {
      return this.reconcileRunning(observed, observedTime);
    }
    if (taskPhase === "verifying") {
      return this.reconcileVerification(observed);
    }
    if (taskPhase === "blocked") {
      const task = this.runtime.getRecord("Task", this.config.taskId);
      const reason = (task.data.status as JsonObject).reason as string;
      if (reason === "LeaseExpired") {
        return this.recoverExpired(observed);
      }
      return this.attentionResult(
        observed,
        attention("TaskBlocked", `Task is blocked: ${reason}`, true),
      );
    }
    return this.attentionResult(
      observed,
      attention("RuntimeInvariantViolation", `Task is in unsupported persisted phase ${taskPhase}`),
    );
  }

  private async dispatch(
    observed: SupervisorState,
    recoveryFromAssignmentId?: string,
  ): Promise<SupervisorReconcileResult> {
    const provider = this.dependencies.provider!;
    const action: SupervisorAction = recoveryFromAssignmentId ? "dispatch_recovery" : "dispatch";
    const commandId = derivedId(
      "command",
      `supervisor:${this.runtime.projectId}:${this.config.taskId}:${this.config.agentId!}:dispatch` +
        (recoveryFromAssignmentId ? `:recovery:${recoveryFromAssignmentId}` : ""),
    );
    try {
      await this.runtime.dispatch(
        this.config.taskId,
        this.config.agentId!,
        commandId,
        {
          executionMode: "adapter",
          providerBinding: {
            id: provider.id,
            version: provider.version,
            capabilities: [...provider.capabilities],
          },
          ...(recoveryFromAssignmentId ? { recoveryFromAssignmentId } : {}),
        },
      );
      return this.result(observed, action, "advanced", null, "reconcile");
    } catch (error) {
      const current = this.readState();
      if (
        error instanceof PkrError &&
        error.code === "PKR-COORD-006" &&
        current.assignment &&
        LIVE_ASSIGNMENTS.has(current.assignment.state)
      ) {
        return this.result(observed, "noop", "noop", null, "reconcile");
      }
      return this.attentionResult(
        observed,
        attention("ReconcileFailed", error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async reconcileRunning(
    observed: SupervisorState,
    observedTime: number,
  ): Promise<SupervisorReconcileResult> {
    const live = this.liveAssignments();
    if (live.length !== 1 || live[0]!.data.state !== "running") {
      return this.attentionResult(
        observed,
        attention("RuntimeInvariantViolation", "inProgress Task requires exactly one running Assignment"),
      );
    }
    const assignment = live[0]!;
    const lease = this.runtime.listRecords("Lease").find(
      (record) => record.data.assignmentId === assignment.id,
    );
    const session = lease
      ? this.runtime.listRecords("AgentSession").find(
          (record) => record.id === lease.data.sessionId,
        )
      : undefined;
    if (!lease || !session) {
      return this.attentionResult(
        observed,
        attention("RuntimeInvariantViolation", "running Assignment has no bound Lease and AgentSession"),
      );
    }
    const expiresAt = Math.min(
      Date.parse(lease.data.expiresAt as string),
      Date.parse(session.data.expiresAt as string),
    );
    if (!Number.isFinite(expiresAt)) {
      return this.attentionResult(
        observed,
        attention("RuntimeInvariantViolation", "running execution has an invalid expiry timestamp"),
      );
    }
    if (expiresAt <= observedTime) {
      try {
        await this.runtime.expireLease(
          lease.id,
          derivedId("command", `supervisor:${lease.id}:expire:${lease.data.expiresAt as string}`),
        );
        return this.result(observed, "expire_lease", "advanced", null, "reconcile");
      } catch (error) {
        return this.concurrentOrFailure(observed, error);
      }
    }

    const effectId = derivedId("effect", `provider:${assignment.id}:execute`);
    const effect = this.runtime.externalEffect(effectId);
    if (effect?.state === "pending") {
      return this.attentionResult(
        observed,
        attention(
          "AmbiguousExternalEffect",
          `Provider effect ${effectId} has an unknown outcome and will not be retried automatically`,
          true,
        ),
      );
    }
    const lastHeartbeat = Date.parse(session.data.lastHeartbeat as string);
    const heartbeatInterval = Number(lease.data.heartbeatIntervalSeconds) * 1000;
    if (
      effect?.state !== "succeeded" &&
      Number.isFinite(lastHeartbeat) &&
      Number.isFinite(heartbeatInterval) &&
      lastHeartbeat + heartbeatInterval <= observedTime
    ) {
      try {
        await this.runtime.heartbeat(
          session.id,
          lease.id,
          derivedId("command", `supervisor:${assignment.id}:heartbeat:${lease.revision}`),
        );
        return this.result(observed, "heartbeat", "advanced", null, "reconcile");
      } catch (error) {
        return this.concurrentOrFailure(observed, error);
      }
    }

    const action: SupervisorAction = effect?.state === "succeeded"
      ? "absorb_provider_result"
      : "execute";
    try {
      await this.lps.executeLane(
        this.config.taskId,
        this.config.agentId!,
        { recoverInterruptedSessions: false },
      );
      const current = this.readState();
      if (current.task?.state === "blocked") {
        const task = this.runtime.getRecord("Task", this.config.taskId);
        return this.result(
          observed,
          action,
          "attention",
          attention(
            "TaskBlocked",
            `execution blocked the Task: ${(task.data.status as JsonObject).reason as string}`,
            true,
          ),
          "owner_review",
        );
      }
      return this.result(observed, action, "advanced", null, "reconcile");
    } catch (error) {
      const currentEffect = this.runtime.externalEffect(effectId);
      if (currentEffect?.state === "pending") {
        return this.attentionResult(
          observed,
          attention(
            "AmbiguousExternalEffect",
            `Provider effect ${effectId} may have occurred and will not be retried automatically`,
            true,
          ),
        );
      }
      return this.attentionResult(
        observed,
        attention("ReconcileFailed", error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async reconcileVerification(
    observed: SupervisorState,
  ): Promise<SupervisorReconcileResult> {
    const submitted = this.liveAssignments().filter((record) => record.data.state === "submitted");
    if (submitted.length !== 1) {
      return this.attentionResult(
        observed,
        attention("RuntimeInvariantViolation", "verifying Task requires exactly one submitted Assignment"),
      );
    }
    const assignment = submitted[0]!;
    const disposition = assignment.data.disposition as string;
    if (["blocked", "externalSignoffBlocked"].includes(disposition)) {
      return this.attentionResult(
        observed,
        attention(
          "ProviderReportedBlocked",
          `Provider work report requires attention: ${disposition}`,
          true,
        ),
      );
    }
    const plan = this.dependencies.verificationPlan!;
    const verifierId = this.config.verification!.actorId;
    const effectId = derivedId("effect", `supervisor:${assignment.id}:verification`);
    const request: JsonObject = {
      taskId: this.config.taskId,
      assignmentId: assignment.id,
      verifierId,
      planDigest: digest(plan),
    };
    let effect = this.runtime.externalEffect(effectId);
    if (!effect) {
      effect = this.runtime.beginVerificationEffect(
        this.config.taskId,
        assignment.id,
        effectId,
        request,
      );
    }
    if (effect.state === "pending" && effect.execute !== true) {
      return this.attentionResult(
        observed,
        attention(
          "AmbiguousVerificationEffect",
          `Verification effect ${effectId} has an unknown outcome and will not be rerun automatically`,
          true,
        ),
      );
    }
    if (effect.state === "failed") {
      return this.attentionResult(
        observed,
        attention("AmbiguousVerificationEffect", `Verification effect ${effectId} failed`, true),
      );
    }

    let verificationEvidence: JsonObject;
    if (effect.execute === true) {
      try {
        verificationEvidence = await runLocalVerification(
          this.runtime.paths.root,
          this.config.taskId,
          assignment.id,
          plan,
        );
        if (process.env.PKR_FAILPOINT === "after-supervisor-verification") {
          throw new Error("PKR failpoint after-supervisor-verification");
        }
        this.runtime.completeExternalEffect(effectId, "succeeded", { verificationEvidence });
      } catch (error) {
        return this.attentionResult(
          observed,
          attention(
            "AmbiguousVerificationEffect",
            `Verification effect ${effectId} may have run: ${error instanceof Error ? error.message : String(error)}`,
            true,
          ),
        );
      }
    } else {
      const retained = effect.result as JsonObject | undefined;
      if (!object(retained?.verificationEvidence)) {
        return this.attentionResult(
          observed,
          attention(
            "AmbiguousVerificationEffect",
            `Verification effect ${effectId} has no replayable evidence`,
            true,
          ),
        );
      }
      verificationEvidence = retained.verificationEvidence as JsonObject;
    }

    try {
      const accepted = await this.runtime.verify(
        this.config.taskId,
        assignment.id,
        verifierId,
        derivedId("command", `supervisor:${assignment.id}:accept:${verificationEvidence.digest as string}`),
        verificationEvidence,
      );
      const passed = (accepted.value as JsonObject).passed === true;
      return this.result(
        observed,
        "verify",
        passed ? "advanced" : "attention",
        passed
          ? null
          : attention("TaskBlocked", "independent Repository Verification failed", true),
        passed ? "none" : "owner_review",
      );
    } catch (error) {
      const current = this.readState();
      const currentTask = current.task;
      if (TERMINAL_TASKS.has(currentTask?.state ?? "") || currentTask?.state === "blocked") {
        return this.result(observed, "noop", "noop", null, currentTask?.state === "done" ? "none" : "owner_review");
      }
      return this.attentionResult(
        observed,
        attention("ReconcileFailed", error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async recoverExpired(observed: SupervisorState): Promise<SupervisorReconcileResult> {
    const expired = this.assignments()
      .filter((record) => record.data.state === "expired")
      .sort(compareRecords)
      .at(-1);
    if (!expired) {
      return this.attentionResult(
        observed,
        attention("RuntimeInvariantViolation", "LeaseExpired Task has no expired Assignment"),
      );
    }
    const providerEffectId = derivedId("effect", `provider:${expired.id}:execute`);
    const providerEffect = this.runtime.externalEffect(providerEffectId);
    if (providerEffect && providerEffect.state !== "failed") {
      return this.attentionResult(
        observed,
        attention(
          "AmbiguousExternalEffect",
          `expired Assignment ${expired.id} has an unabsorbed Provider effect`,
          true,
        ),
      );
    }
    return this.dispatch(observed, expired.id);
  }

  private async prerequisiteAttention(): Promise<SupervisorAttention | null> {
    const issue = this.dependencies.configurationIssues?.[0];
    if (issue) return issue;
    if (!this.config.agentId) {
      return attention("MissingAgentConfiguration", "Supervisor requires one explicit Agent ID");
    }
    const agent = this.runtime.listRecords("Agent").find((record) => record.id === this.config.agentId);
    if (!agent) {
      return attention("AgentNotFound", `configured Agent ${this.config.agentId} does not exist`);
    }
    if ((agent.data.status as JsonObject).phase !== "active") {
      return attention("AgentNotActive", `configured Agent ${this.config.agentId} is not active`);
    }
    const provider = this.dependencies.provider;
    if (!provider) {
      return attention(
        "MissingProviderConfiguration",
        "Supervisor requires one explicit Provider Adapter; automatic selection is not supported",
      );
    }
    if (!this.config.verification || !this.dependencies.verificationPlan) {
      return attention(
        "MissingVerificationConfiguration",
        "Supervisor requires one explicit Verification plan and verifier identity",
      );
    }
    if (this.config.verification.actorId === this.config.agentId) {
      return attention(
        "VerifierNotIndependent",
        "Verifier identity must differ from the configured execution Agent",
      );
    }
    try {
      const binding = this.runtime.inspectProviderAdapterBinding({
        id: provider.id,
        version: provider.version,
        capabilities: [...provider.capabilities],
      });
      if (JSON.stringify(binding.isolation) !== JSON.stringify(provider.isolation)) {
        return attention(
          "InvalidProviderConfiguration",
          `Provider ${provider.id}@${provider.version} isolation differs from its Runtime binding`,
        );
      }
    } catch (error) {
      return attention(
        "InvalidProviderConfiguration",
        error instanceof Error ? error.message : String(error),
      );
    }
    const available = new Set(provider.capabilities);
    const missing = (this.config.requiredCapabilities ?? []).filter(
      (capability) => !available.has(capability),
    );
    if (missing.length > 0) {
      return attention(
        "MissingProviderCapability",
        `configured Provider lacks required capabilities: ${missing.join(", ")}`,
      );
    }
    for (const requirement of this.config.skillRequirements ?? []) {
      if (!this.dependencies.skillResolver) {
        return attention(
          "MissingSkillResolver",
          `Skill ${requirement.id} was explicitly required but no host resolver was configured`,
        );
      }
      const resolved = await this.dependencies.skillResolver.resolve(requirement);
      const capabilities = new Set(resolved?.capabilities ?? []);
      const missingSkillCapabilities = requirement.capabilities.filter(
        (capability) => !capabilities.has(capability),
      );
      if (resolved?.id !== requirement.id || missingSkillCapabilities.length > 0) {
        return attention(
          "MissingSkillCapability",
          `Skill ${requirement.id} does not provide: ${missingSkillCapabilities.join(", ") || "the required identity"}`,
        );
      }
    }
    return null;
  }

  private unresolvedClarification(): SupervisorAttention | null {
    const task = this.runtime.getRecord("Task", this.config.taskId);
    const subjectIds = new Set([task.id]);
    for (const relation of task.data.relations as JsonObject[]) {
      const target = relation.target as JsonObject;
      if (relation.type === "contributesTo" && target.kind === "Goal") {
        subjectIds.add(target.id as string);
      }
    }
    for (const run of this.runtime.listRecords("WorkflowRun")) {
      if (!UNRESOLVED_CLARIFICATIONS.has(run.data.state as string)) continue;
      const extension = (run.data.extensions as JsonObject | undefined)?.["pkr.clarification/v1"] as
        JsonObject | undefined;
      const subject = extension?.subject as JsonObject | undefined;
      if (!extension || !subject || !subjectIds.has(subject.id as string)) continue;
      const blockedActions = extension.blockedActions as unknown[] | undefined;
      const assessment = extension.assessment as JsonObject | undefined;
      const protectedAction = assessment?.blocking === true || (blockedActions?.length ?? 0) > 0;
      return protectedAction
        ? attention(
            "ProtectedDecisionRequired",
            `clarification ${run.id} requires an explicit Owner decision`,
            true,
          )
        : attention(
            "ClarificationRequired",
            `clarification ${run.id} must resolve before automatic execution`,
            true,
          );
    }
    return null;
  }

  private concurrentOrFailure(
    observed: SupervisorState,
    error: unknown,
  ): SupervisorReconcileResult {
    const current = this.readState();
    if (
      error instanceof PkrError &&
      ["PKR-COORD-004", "PKR-COORD-006"].includes(error.code) &&
      current.sequence > observed.sequence
    ) {
      return this.result(observed, "noop", "noop", null, "reconcile");
    }
    return this.attentionResult(
      observed,
      attention("ReconcileFailed", error instanceof Error ? error.message : String(error)),
    );
  }

  private attentionResult(
    observed: SupervisorState,
    value: SupervisorAttention,
  ): SupervisorReconcileResult {
    return this.result(observed, "owner_attention", "attention", value, "owner_review");
  }

  private result(
    observed: SupervisorState,
    action: SupervisorAction,
    outcome: SupervisorReconcileResult["outcome"],
    attentionValue: SupervisorAttention | null,
    nextAction: SupervisorReconcileResult["nextAction"],
  ): SupervisorReconcileResult {
    return {
      version: "pkr.supervisor-result/v1",
      observedSequence: observed.sequence,
      observed,
      action,
      outcome,
      resultState: this.readState(),
      attention: attentionValue,
      nextAction,
    };
  }

  private readState(): SupervisorState {
    const sequence = this.runtime.listEvents().at(-1)?.sequence ?? 0;
    const task = this.runtime.listRecords("Task").find((record) => record.id === this.config.taskId);
    const assignment = this.assignments().sort(compareRecords).at(-1);
    return {
      sequence,
      task: task ? recordState(task, (task.data.status as JsonObject).phase as string) : null,
      assignment: assignment ? recordState(assignment, assignment.data.state as string) : null,
    };
  }

  private assignments(): StoredRecord[] {
    return this.runtime.listRecords("Assignment").filter(
      (record) => record.data.taskId === this.config.taskId,
    );
  }

  private liveAssignments(): StoredRecord[] {
    return this.assignments().filter((record) => LIVE_ASSIGNMENTS.has(record.data.state as string));
  }
}

function compareRecords(left: StoredRecord, right: StoredRecord): number {
  const leftSequence = Number(left.data.projectSequence ?? 0);
  const rightSequence = Number(right.data.projectSequence ?? 0);
  return leftSequence - rightSequence || left.revision - right.revision || left.id.localeCompare(right.id);
}

function recordState(record: StoredRecord, state: string): SupervisorRecordState {
  return { id: record.id, revision: record.revision, state };
}
