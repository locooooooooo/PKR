import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ContractValidator } from "./contracts.js";
import { PkrError } from "./errors.js";
import {
  HTTP_JSON_ADAPTER_CONTRACT,
  LOCAL_PROCESS_ADAPTER_CONTRACT,
} from "./provider-contract.js";
import {
  adapterCallbackFailure,
  evaluateAdapterCanary,
  evaluatePolicyCanary,
  evaluatePromptCanary,
  evaluateWorkflowCanary,
  promptTemplateVariables,
  type EvolutionCandidateSpec,
  type EvolutionObservationSpec,
  type GovernancePolicyContent,
  type ManagedAdapterContent,
  validateEvolutionCandidate,
  validateGovernancePolicy,
  validateEvolutionObservation,
  validateExternalSupervisorResult,
  validateManagedAdapter,
} from "./evolution-model.js";
import {
  accountableOwner,
  adapterVersionObject,
  agentObject,
  constraintObject,
  decisionObject,
  evolutionCandidateObject,
  evolutionEvaluationArtifactObject,
  evolutionVerificationObject,
  goalObject,
  governanceWorkflowObject,
  knowledgeObject,
  issueObject,
  metricObject,
  missionObject,
  ownerRoleObject,
  profileWorkflowObject,
  repositoryVerificationArtifactObject,
  reviseControl,
  revisePom,
  taskObject,
  verificationObject,
} from "./objects.js";
import type { ProfilePackage } from "./profiles.js";
import { rebuildProjections } from "./projection.js";
import {
  PkrStore,
  commandContent,
  type CompactionResult,
  type RetentionPolicy,
  type StoreSnapshot,
  type StoreTransaction,
} from "./store.js";
import type {
  CommandResult,
  InitOptions,
  JsonObject,
  JsonValue,
  MetricThreshold,
  RuntimeEvent,
  RuntimePaths,
  StoredRecord,
} from "./types.js";
import { derivedId, digest, newId, now, slug, writeJsonAtomic } from "./util.js";
import { evaluateExpression, parseWorkflowDefinition } from "./workflow.js";

const HOUR_MS = 60 * 60 * 1000;
const WORKSPACE_MS = 15 * 60 * 1000;
const PACKAGE_CAPABILITY_CEILING = new Set([
  "filesystem.read",
  "filesystem.write",
  "terminal",
]);
const EXECUTION_REQUIRED_CAPABILITIES = [
  "filesystem.read",
  "filesystem.write",
  "terminal",
];

const BUILTIN_ADAPTER_BINDINGS = [
  LOCAL_PROCESS_ADAPTER_CONTRACT,
  HTTP_JSON_ADAPTER_CONTRACT,
] as const;

const AGENT_NATIVE_BINDING = {
  id: "pkr.agent-native",
  version: "0.8.0",
  capabilities: ["filesystem.read", "filesystem.write", "terminal"],
  protocolVersion: "pkr.dev/v0.4" as const,
  isolation: {
    filesystem: "scoped" as const,
    network: "none" as const,
    credentials: "references-only" as const,
  },
};

export interface ProviderAdapterBinding {
  id: string;
  version: string;
  capabilities: string[];
}

export interface DispatchOptions {
  executionMode?: "agent-native" | "adapter";
  providerBinding?: ProviderAdapterBinding;
  sessionLocator?: string;
  repositoryBaseline?: JsonObject;
  recoveryFromAssignmentId?: string;
}

function normalizeDispatchOptions(
  input?: ProviderAdapterBinding | DispatchOptions,
): DispatchOptions {
  if (!input) {
    return { executionMode: "agent-native" };
  }
  if (
    "executionMode" in input ||
    "providerBinding" in input ||
    "sessionLocator" in input ||
    "repositoryBaseline" in input ||
    "recoveryFromAssignmentId" in input
  ) {
    return input as DispatchOptions;
  }
  return {
    executionMode: "adapter",
    providerBinding: input as ProviderAdapterBinding,
  };
}

function metricThresholdSatisfied(
  value: string | number | boolean,
  threshold: MetricThreshold,
): boolean {
  if (threshold.operator === "eq") {
    return value === threshold.value;
  }
  if (threshold.operator === "neq") {
    return value !== threshold.value;
  }
  if (typeof value !== "number" || typeof threshold.value !== "number") {
    throw new PkrError(
      "PKR-METRIC-001",
      `${threshold.operator} Metric thresholds require numeric values`,
    );
  }
  switch (threshold.operator) {
    case "gt": return value > threshold.value;
    case "gte": return value >= threshold.value;
    case "lt": return value < threshold.value;
    case "lte": return value <= threshold.value;
    default:
      throw new PkrError("PKR-METRIC-001", "unsupported Metric threshold operator");
  }
}

function validateProcessEvidence(evidence: JsonObject): void {
  if (
    !evidence ||
    typeof evidence.executable !== "string" ||
    !Array.isArray(evidence.args) ||
    evidence.args.some((argument) => typeof argument !== "string") ||
    typeof evidence.cwd !== "string" ||
    !(evidence.exitCode === null || Number.isInteger(evidence.exitCode)) ||
    !(evidence.signal === null || typeof evidence.signal === "string") ||
    typeof evidence.stdout !== "string" ||
    typeof evidence.stderr !== "string" ||
    typeof evidence.timedOut !== "boolean" ||
    !(evidence.failureReason === null || typeof evidence.failureReason === "string") ||
    typeof evidence.startedAt !== "string" ||
    typeof evidence.completedAt !== "string" ||
    !Number.isInteger(evidence.durationMs) ||
    (evidence.durationMs as number) < 0
  ) {
    throw new PkrError("PKR-COORD-008", "process evidence is incomplete");
  }
}

function normalizeVerificationPattern(pattern: string): string {
  return pattern.replaceAll("\\", "/").replace(/^\.\//, "");
}

function validVerificationPattern(pattern: string): boolean {
  const normalized = normalizeVerificationPattern(pattern);
  return normalized === "**" ||
    (!!normalized && !normalized.startsWith("/") && !normalized.includes("..") &&
      (!normalized.includes("*") || normalized.endsWith("/**")));
}

function matchesVerificationPath(path: string, pattern: string): boolean {
  const normalized = normalizeVerificationPattern(pattern);
  if (normalized === "**") {
    return true;
  }
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3).replace(/\/$/, "");
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === normalized;
}

function sameOrderedStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateRepositoryVerificationEvidence(
  evidence: JsonObject,
  taskId: string,
  assignmentId: string,
  repositoryRoot: string,
): { passed: boolean; evidenceDigest: string } {
  if (!evidence || Array.isArray(evidence)) {
    throw new PkrError("PKR-VERIFY-001", "formal repository verification evidence is required");
  }
  const suppliedDigest = evidence.digest;
  const { digest: _ignored, ...content } = evidence;
  const evidenceDigest = digest(content);
  const repository = evidence.repository as JsonObject | undefined;
  const scope = evidence.scope as JsonObject | undefined;
  const commands = evidence.commands as JsonObject[] | undefined;
  if (
    evidence.adapter !== "pkr.local-verifier/v1" ||
    evidence.taskId !== taskId ||
    evidence.assignmentId !== assignmentId ||
    typeof evidence.planDigest !== "string" ||
    suppliedDigest !== evidenceDigest ||
    !repository ||
    repository.adapter !== "pkr.git-workspace/v1" ||
    typeof repository.repositoryRoot !== "string" ||
    typeof repository.contentDigest !== "string" ||
    typeof repository.head !== "string" ||
    typeof repository.status !== "string" ||
    typeof repository.diff !== "string" ||
    typeof repository.stagedDiff !== "string" ||
    typeof repository.clean !== "boolean" ||
    typeof repository.collectedAt !== "string" ||
    !Array.isArray(repository.changedFiles) ||
    repository.changedFiles.some((path) => typeof path !== "string") ||
    !scope ||
    typeof scope.passed !== "boolean" ||
    typeof scope.requireChanges !== "boolean" ||
    !Array.isArray(scope.allowedPaths) ||
    scope.allowedPaths.some((pattern) =>
      typeof pattern !== "string" || !validVerificationPattern(pattern)
    ) ||
    !Array.isArray(scope.forbiddenPaths) ||
    scope.forbiddenPaths.some((pattern) =>
      typeof pattern !== "string" || !validVerificationPattern(pattern)
    ) ||
    !Array.isArray(scope.outsideAllowed) ||
    scope.outsideAllowed.some((path) => typeof path !== "string") ||
    !Array.isArray(scope.forbidden) ||
    scope.forbidden.some((path) => typeof path !== "string") ||
    !Array.isArray(commands) ||
    commands.length === 0
  ) {
    throw new PkrError("PKR-VERIFY-001", "repository verification evidence is incomplete or inconsistent");
  }
  const changedFiles = repository.changedFiles as string[];
  const allowedPaths = scope.allowedPaths as string[];
  const forbiddenPaths = scope.forbiddenPaths as string[];
  const outsideAllowed = scope.outsideAllowed as string[];
  const forbidden = scope.forbidden as string[];
  const expectedRepositoryDigest = digest({
    head: repository.head,
    status: repository.status,
    diff: repository.diff,
    stagedDiff: repository.stagedDiff,
    changedFiles,
  });
  const expectedOutsideAllowed = changedFiles.filter((path) =>
    !allowedPaths.some((pattern) => matchesVerificationPath(path, pattern)),
  );
  const expectedForbidden = changedFiles.filter((path) =>
    forbiddenPaths.some((pattern) => matchesVerificationPath(path, pattern)),
  );
  const scopePassed = expectedOutsideAllowed.length === 0 && expectedForbidden.length === 0 &&
    (scope.requireChanges !== true || changedFiles.length > 0);
  if (
    resolve(repository.repositoryRoot as string).toLowerCase() !== resolve(repositoryRoot).toLowerCase() ||
    repository.contentDigest !== expectedRepositoryDigest ||
    repository.clean !== (changedFiles.length === 0) ||
    !sameOrderedStrings(outsideAllowed, expectedOutsideAllowed) ||
    !sameOrderedStrings(forbidden, expectedForbidden) ||
    scope.passed !== scopePassed
  ) {
    throw new PkrError("PKR-VERIFY-001", "repository or scope evidence conflicts with its source fields");
  }
  for (const command of commands) {
    validateProcessEvidence(command);
    if (typeof command.id !== "string" || !command.id) {
      throw new PkrError("PKR-VERIFY-001", "verification command evidence requires an id");
    }
  }
  const commandsPassed = commands.every((command) =>
    command.exitCode === 0 && command.timedOut === false && command.failureReason === null,
  );
  const passed = scopePassed && commandsPassed;
  const expectedReason = !scopePassed
    ? "RepositoryScopeFailed"
    : !commandsPassed ? "VerificationCommandFailed" : "VerificationPassed";
  if (evidence.passed !== passed || evidence.reason !== expectedReason) {
    throw new PkrError("PKR-VERIFY-001", "verification verdict conflicts with its command or scope evidence");
  }
  return { passed, evidenceDigest };
}

function versionSatisfies(version: string, range: string): boolean {
  if (range === version || range === "*") {
    return true;
  }
  const match = /^(\^|~)?(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const candidate = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || !candidate) {
    return false;
  }
  const requested = match.slice(2).map(Number);
  const actual = candidate.slice(1).map(Number);
  if (match[1] === "^") {
    return actual[0] === requested[0] && (
      actual[1]! > requested[1]! ||
      (actual[1] === requested[1] && actual[2]! >= requested[2]!)
    );
  }
  if (match[1] === "~") {
    return actual[0] === requested[0] && actual[1] === requested[1] && actual[2]! >= requested[2]!;
  }
  return false;
}

export class PkrRuntime {
  private constructor(
    readonly paths: RuntimePaths,
    readonly repositoryRoot: string,
    readonly projectId: string,
    private readonly store: PkrStore,
    private readonly contracts: ContractValidator,
  ) {}

  static paths(projectRoot: string): RuntimePaths {
    const root = resolve(projectRoot);
    const stateDir = join(root, ".pkr");
    return {
      root,
      stateDir,
      database: join(stateDir, "runtime.sqlite"),
      projections: join(stateDir, "projections"),
      config: join(stateDir, "config.json"),
    };
  }

  static async init(
    projectRoot: string,
    repositoryRoot: string,
    options: InitOptions,
  ): Promise<PkrRuntime> {
    const paths = PkrRuntime.paths(projectRoot);
    const stateExisted = existsSync(paths.stateDir);
    await mkdir(paths.stateDir, { recursive: true });
    const store = new PkrStore(paths.database);
    const contracts = new ContractValidator(repositoryRoot);
    if (store.findProjectId()) {
      store.close();
      throw new PkrError("PKR-BOOTSTRAP-001", "project is already initialized", "conflict");
    }

    const projectName = slug(options.name);
    const projectId = `project_${projectName}_001`;
    const missionId = `mission_${projectName}_001`;
    const roleId = `role_${projectName}_owner`;
    const workflowId = `workflow_${projectName}_governance`;
    const authorityId = options.authorityId ?? "human_001";
    const requestId = options.requestId ?? `request_${projectName}_001`;
    const transactionId = newId("transaction");
    const terminalEventId = newId("event");
    const committedAt = now();

    const mission = missionObject({
      id: missionId,
      projectId,
      outcome: options.outcome,
      createdBy: authorityId,
      revision: 2,
      phase: "active",
    });
    const role = ownerRoleObject({
      id: roleId,
      projectId,
      createdBy: authorityId,
      revision: 2,
      phase: "active",
    });
    const workflow = governanceWorkflowObject({
      id: workflowId,
      projectId,
      createdBy: authorityId,
      revision: 2,
      phase: "active",
    });
    const manifest: JsonObject = {
      apiVersion: "pkr.dev/v0.2",
      kind: "ProjectManifest",
      metadata: {
        projectId,
        name: projectName,
        title: options.title,
        ...(options.description ? { description: options.description } : {}),
        revision: 1,
        createdAt: committedAt,
        createdBy: authorityId,
        updatedAt: committedAt,
      },
      runtime: {
        pkrVersion: "0.2",
        objectApiVersion: "pkr.dev/v0.2",
        objectSchemaId: "https://pkr.dev/schemas/v0.2/pkr-object.schema.json",
        bootstrapSchemaId: "https://pkr.dev/schemas/v0.2/pkr-bootstrap.schema.json",
        missionMode: "single",
      },
      governance: {
        ownerRoleId: roleId,
        governanceWorkflowId: workflowId,
      },
      mission: { activeMissionId: missionId },
      genesis: {
        requestId,
        transactionId,
        eventRange: { firstSequence: 1, lastSequence: 8 },
        terminalEventId,
        committedAt,
      },
      status: {
        phase: "active",
        reason: "BootstrapCommitted",
        observedRevision: 1,
      },
      extensions: {},
    };
    const genesis: JsonObject = {
      apiVersion: "pkr.dev/v0.2",
      kind: "ProjectGenesisRecord",
      projectId,
      requestId,
      transactionId,
      authority: { principalType: "human", principalId: authorityId },
      decisionBasis: {
        type: "genesis",
        reason: "Create a human-owned PKR project through the built-in bootstrap policy.",
      },
      policy: { name: "pkr/bootstrap", version: "0.2" },
      committedAt,
      manifestRevision: 1,
      createdObjects: [
        { kind: "Role", id: roleId, revision: 2 },
        { kind: "Workflow", id: workflowId, revision: 2 },
        { kind: "Mission", id: missionId, revision: 2 },
      ],
      eventRange: { firstSequence: 1, lastSequence: 8 },
      terminalEventId,
      extensions: {},
    };

    contracts.validateObject(role);
    contracts.validateObject(workflow);
    contracts.validateObject(mission);
    contracts.validateBootstrap(manifest);
    contracts.validateBootstrap(genesis);

    try {
      store.execute(
        projectId,
        requestId,
        commandContent({ kind: "ProjectBootstrapRequest", projectId, requestId }),
        (transaction) => {
          if (transaction.startSequence !== 0) {
            throw new PkrError("PKR-BOOTSTRAP-001", "bootstrap requires empty state");
          }
          transaction.seedRecord("ProjectManifest", projectId, 1, manifest);
          transaction.seedRecord("ProjectGenesisRecord", `genesis_${projectName}_001`, 1, genesis);
          transaction.seedRecord("Role", roleId, 2, role);
          transaction.seedRecord("Workflow", workflowId, 2, workflow);
          transaction.seedRecord("Mission", missionId, 2, mission);
          transaction.appendEvent("pkr.project.created", "ProjectManifest", projectId, 1);
          transaction.appendEvent("pkr.role.created", "Role", roleId, 1);
          transaction.appendEvent("pkr.role.phaseChanged", "Role", roleId, 2, { from: "draft", to: "active" });
          transaction.appendEvent("pkr.workflow.created", "Workflow", workflowId, 1);
          transaction.appendEvent("pkr.workflow.phaseChanged", "Workflow", workflowId, 2, { from: "draft", to: "active" });
          transaction.appendEvent("pkr.mission.created", "Mission", missionId, 1);
          transaction.appendEvent("pkr.mission.phaseChanged", "Mission", missionId, 2, { from: "draft", to: "active" });
          transaction.appendEvent("pkr.project.bootstrapped", "ProjectManifest", projectId, 1, {}, terminalEventId);
          return transaction.committed({ projectId, manifestId: projectId });
        },
      );
      const runtime = new PkrRuntime(paths, repositoryRoot, projectId, store, contracts);
      await writeJsonAtomic(paths.config, {
        apiVersion: "pkr.dev/v0.5",
        projectId,
        database: "runtime.sqlite",
      });
      await runtime.rebuildProjections();
      return runtime;
    } catch (error) {
      store.close();
      if (!stateExisted) {
        await rm(paths.stateDir, { recursive: true, force: true });
      }
      throw error;
    }
  }

  static async open(projectRoot: string, repositoryRoot: string): Promise<PkrRuntime> {
    const paths = PkrRuntime.paths(projectRoot);
    if (!existsSync(paths.database)) {
      throw new PkrError("PKR-RUNTIME-007", "no PKR project found in this directory");
    }
    const store = new PkrStore(paths.database);
    let projectId: string | undefined;
    if (existsSync(paths.config)) {
      const config = JSON.parse(await readFile(paths.config, "utf8")) as { projectId?: string };
      projectId = config.projectId;
    }
    projectId ??= store.findProjectId();
    if (!projectId) {
      store.close();
      throw new PkrError("PKR-RUNTIME-007", "PKR database has no ProjectManifest");
    }
    const runtime = new PkrRuntime(
      paths,
      repositoryRoot,
      projectId,
      store,
      new ContractValidator(repositoryRoot),
    );
    try {
      await runtime.recoverInterruptedSessions();
      return runtime;
    } catch (error) {
      runtime.close();
      throw error;
    }
  }

  static async restore(
    snapshotPath: string,
    projectRoot: string,
    repositoryRoot: string,
  ): Promise<PkrRuntime> {
    const paths = PkrRuntime.paths(projectRoot);
    if (existsSync(paths.config)) {
      throw new PkrError(
        "PKR-RECOVERY-004",
        "restore target already has Runtime configuration; refusing a stale overwrite",
      );
    }
    await mkdir(paths.stateDir, { recursive: true });
    const snapshot = PkrStore.restoreSnapshot(snapshotPath, paths.database);
    await writeJsonAtomic(paths.config, {
      apiVersion: "pkr.dev/v0.5",
      projectId: snapshot.projectId,
      database: "runtime.sqlite",
    });
    const runtime = await PkrRuntime.open(projectRoot, repositoryRoot);
    await runtime.rebuildProjections();
    return runtime;
  }

  close(): void {
    this.store.close();
  }

  getRecord(kind: string, id: string): StoredRecord {
    const record = this.store.getRecord(this.projectId, kind, id);
    if (!record) {
      throw new PkrError("PKR-RUNTIME-007", `${kind}/${id} was not found`);
    }
    return record;
  }

  listRecords(kind?: string): StoredRecord[] {
    return this.store.listRecords(this.projectId, kind);
  }

  listEvents(afterSequence = 0): RuntimeEvent[] {
    return this.store.listEvents(this.projectId, afterSequence);
  }

  createSnapshot(targetPath: string): StoreSnapshot {
    return this.store.createSnapshot(this.projectId, resolve(targetPath));
  }

  compact(policy: RetentionPolicy): CompactionResult {
    return this.store.compact(this.projectId, policy);
  }

  exportPublicAlpha(targetPath: string): void {
    this.store.exportPublicAlpha(this.projectId, resolve(targetPath));
  }

  status(): JsonObject {
    const manifest = this.getRecord("ProjectManifest", this.projectId).data;
    const events = this.listEvents();
    const counts: Record<string, number> = {};
    for (const record of this.listRecords()) {
      counts[record.kind] = (counts[record.kind] ?? 0) + 1;
    }
    return {
      projectId: this.projectId,
      title: ((manifest.metadata as JsonObject).title as string),
      phase: ((manifest.status as JsonObject).phase as string),
      projectSequence: events.at(-1)?.sequence ?? 0,
      stateDigest: this.store.stateDigest(this.projectId),
      storeFormat: this.store.format(),
      storeOpen: this.store.openReport as unknown as JsonObject,
      pendingExternalEffects: this.store
        .listExternalEffects(this.projectId)
        .filter((effect) => effect.state === "pending").length,
      recordCounts: counts,
    };
  }

  ownerId(): string {
    const manifest = this.getRecord("ProjectManifest", this.projectId).data;
    return (manifest.metadata as JsonObject).createdBy as string;
  }

  inspectProviderAdapterBinding(binding: ProviderAdapterBinding): JsonObject {
    const resolved = this.resolveProviderAdapterBinding(binding);
    return {
      id: resolved.id,
      version: resolved.version,
      capabilities: resolved.capabilities,
      protocolVersion: resolved.protocolVersion,
      adapterVersionId: resolved.adapterVersionId,
      contentDigest: resolved.contentDigest,
      isolation: resolved.isolation,
    };
  }

  async createGoal(
    outcome: string,
    actorId = "human_001",
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    const manifest = this.getRecord("ProjectManifest", this.projectId).data;
    const missionId = (manifest.mission as JsonObject).activeMissionId as string;
    const goalId = derivedId("goal", commandId);
    const goal = goalObject({
      id: goalId,
      projectId: this.projectId,
      missionId,
      outcome,
      createdBy: actorId,
    });
    this.contracts.validateObject(goal);
    return this.mutate(commandId, { action: "createGoal", goalId, outcome }, (transaction) => {
      transaction.putRecord("Goal", goalId, 0, goal);
      transaction.appendEvent("pkr.goal.created", "Goal", goalId, 1);
      return transaction.committed(goal);
    });
  }

  async createTask(
    goalId: string,
    objective: string,
    actorId = "human_001",
    commandId = newId("command"),
    extensions?: JsonObject,
  ): Promise<CommandResult<JsonObject>> {
    this.getRecord("Goal", goalId);
    const manifest = this.getRecord("ProjectManifest", this.projectId).data;
    const workflowId = (manifest.governance as JsonObject).governanceWorkflowId as string;
    const taskId = derivedId("task", commandId);
    const task = taskObject({
      id: taskId,
      projectId: this.projectId,
      goalId,
      workflowId,
      objective,
      createdBy: actorId,
      ...(extensions ? { extensions } : {}),
    });
    this.contracts.validateObject(task);
    return this.mutate(commandId, {
      action: "createTask",
      taskId,
      goalId,
      objective,
      ...(extensions ? { extensions } : {}),
    }, (transaction) => {
      transaction.putRecord("Task", taskId, 0, task);
      transaction.appendEvent("pkr.task.created", "Task", taskId, 1);
      return transaction.committed(task);
    });
  }

  async registerAgent(
    name: string,
    host: string,
    actorId = "human_001",
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    const agentId = derivedId("agent", commandId);
    const registered = agentObject({
      id: agentId,
      projectId: this.projectId,
      name: slug(name),
      host: slug(host),
      createdBy: actorId,
    });
    const active = agentObject({
      id: agentId,
      projectId: this.projectId,
      name: slug(name),
      host: slug(host),
      createdBy: actorId,
      revision: 2,
      phase: "active",
    });
    this.contracts.validateObject(registered);
    this.contracts.validateObject(active);
    return this.mutate(commandId, { action: "registerAgent", agentId, name, host }, (transaction) => {
      transaction.putRecord("Agent", agentId, 0, registered);
      transaction.appendEvent("pkr.agent.registered", "Agent", agentId, 1);
      transaction.putRecord("Agent", agentId, 1, active);
      transaction.appendEvent("pkr.agent.phaseChanged", "Agent", agentId, 2, { from: "registered", to: "active" });
      return transaction.committed(active);
    });
  }

  async createDecision(
    question: string,
    choice: string,
    reason: string,
    affectedKinds: string[],
    actorId: string,
    commandId = newId("command"),
    extensions?: JsonObject,
  ): Promise<CommandResult<JsonObject>> {
    const manifest = this.getRecord("ProjectManifest", this.projectId).data;
    const ownerId = (manifest.metadata as JsonObject).createdBy as string;
    if (actorId !== ownerId) {
      throw new PkrError(
        "PKR-RUNTIME-004",
        `material Decision requires Project owner ${ownerId}`,
      );
    }
    const decisionId = derivedId("decision", commandId);
    const proposed = decisionObject({
      id: decisionId,
      projectId: this.projectId,
      question,
      choice,
      reason,
      affectedKinds,
      createdBy: actorId,
      ...(extensions ? { extensions } : {}),
    });
    const accepted = decisionObject({
      id: decisionId,
      projectId: this.projectId,
      question,
      choice,
      reason,
      affectedKinds,
      createdBy: actorId,
      revision: 2,
      phase: "accepted",
      ...(extensions ? { extensions } : {}),
    });
    this.contracts.validateObject(proposed);
    this.contracts.validateObject(accepted);
    return this.mutate(
      commandId,
      {
        action: "createDecision",
        decisionId,
        question,
        choice,
        reason,
        affectedKinds,
        ...(extensions ? { extensions } : {}),
      },
      (transaction) => {
        transaction.putRecord("Decision", decisionId, 0, proposed);
        transaction.appendEvent("pkr.decision.proposed", "Decision", decisionId, 1);
        transaction.putRecord("Decision", decisionId, 1, accepted);
        transaction.appendEvent("pkr.decision.accepted", "Decision", decisionId, 2);
        return transaction.committed(accepted);
      },
    );
  }

  async dispatch(
    taskId: string,
    agentId: string,
    commandId = newId("command"),
    input?: ProviderAdapterBinding | DispatchOptions,
  ): Promise<CommandResult<JsonObject>> {
    const options = normalizeDispatchOptions(input);
    const executionMode = options.executionMode ?? (options.providerBinding ? "adapter" : "agent-native");
    if (executionMode === "adapter" && !options.providerBinding) {
      throw new PkrError("PKR-COORD-005", "Adapter dispatch requires an explicit Provider Adapter binding");
    }
    if (options.sessionLocator !== undefined && !options.sessionLocator.trim()) {
      throw new PkrError("PKR-COORD-005", "Agent session locator cannot be empty");
    }
    const requestedBinding = options.providerBinding
      ? {
          id: options.providerBinding.id,
          version: options.providerBinding.version,
          capabilities: [...options.providerBinding.capabilities],
        }
      : undefined;
    const command = commandContent({
      action: "dispatch",
      taskId,
      agentId,
      executionMode,
      ...(requestedBinding ? { providerBinding: requestedBinding } : {}),
      ...(options.sessionLocator ? { sessionLocator: options.sessionLocator } : {}),
      ...(options.repositoryBaseline ? { repositoryBaseline: options.repositoryBaseline } : {}),
      ...(options.recoveryFromAssignmentId
        ? { recoveryFromAssignmentId: options.recoveryFromAssignmentId }
        : {}),
    });
    const replay = this.store.replay<JsonObject>(this.projectId, commandId, command);
    if (replay) {
      return replay;
    }
    const adapterBinding = executionMode === "agent-native"
      ? {
          ...AGENT_NATIVE_BINDING,
          capabilities: [...AGENT_NATIVE_BINDING.capabilities],
          adapterVersionId: null,
          contentDigest: null,
        }
      : this.resolveProviderAdapterBinding(requestedBinding!);
    const missingCapabilities = EXECUTION_REQUIRED_CAPABILITIES.filter(
      (capability) => !adapterBinding.capabilities.includes(capability),
    );
    if (missingCapabilities.length !== 0) {
      throw new PkrError(
        "PKR-COORD-005",
        `Execution contract ${adapterBinding.id}@${adapterBinding.version} lacks required capabilities: ` +
          missingCapabilities.join(", "),
      );
    }
    const taskRecord = this.getRecord("Task", taskId);
    const taskStatus = taskRecord.data.status as JsonObject;
    const taskPhase = taskStatus.phase as string;
    const priorAssignments = this.listRecords("Assignment").filter(
      (record) => record.data.taskId === taskId,
    );
    const liveAssignment = priorAssignments.find((record) =>
      ["offered", "accepted", "running", "submitted"].includes(record.data.state as string),
    );
    if (liveAssignment) {
      throw new PkrError(
        "PKR-COORD-006",
        `dispatch rejected duplicate live work: Assignment ${liveAssignment.id} is ${liveAssignment.data.state as string}`,
        "conflict",
      );
    }
    const priorAssignmentIds = new Set(priorAssignments.map((record) => record.id));
    const livePriorLease = this.listRecords("Lease").find((record) =>
      priorAssignmentIds.has(record.data.assignmentId as string) &&
      ["active", "renewed"].includes(record.data.state as string),
    );
    if (livePriorLease) {
      throw new PkrError(
        "PKR-COORD-006",
        `dispatch rejected duplicate live work: Lease ${livePriorLease.id} is still live`,
        "conflict",
      );
    }
    const recoveryAssignment = options.recoveryFromAssignmentId
      ? priorAssignments.find((record) => record.id === options.recoveryFromAssignmentId)
      : undefined;
    const recovery = taskPhase === "blocked" &&
      taskStatus.reason === "LeaseExpired" &&
      recoveryAssignment?.data.state === "expired";
    if (taskPhase !== "backlog" && !recovery) {
      throw new PkrError(
        "PKR-COORD-006",
        "dispatch requires a backlog Task or an explicit expired-Assignment recovery",
        "conflict",
      );
    }
    if (options.recoveryFromAssignmentId && !recovery) {
      throw new PkrError(
        "PKR-RECOVERY-001",
        `Assignment ${options.recoveryFromAssignmentId} is not a recoverable expired execution`,
      );
    }
    if (
      recoveryAssignment &&
      priorAssignments.some((record) => record.data.state === "expired" &&
        this.store.listExternalEffects(this.projectId, record.id)
          .some((effect) => effect.state !== "failed"),
      )
    ) {
      throw new PkrError(
        "PKR-RECOVERY-003",
        `Task ${taskId} has an unabsorbed external effect from an expired Assignment; reconcile it before reassignment`,
      );
    }
    const agentRecord = this.getRecord("Agent", agentId);
    const agentStatus = agentRecord.data.status as JsonObject;
    if (agentStatus.phase !== "active") {
      throw new PkrError("PKR-COORD-005", "dispatch requires an active Agent");
    }
    const workflowRelation = (taskRecord.data.relations as JsonValue[]).find(
      (relation) =>
        ((relation as JsonObject).type as string) === "governedBy",
    ) as JsonObject | undefined;
    if (!workflowRelation) {
      throw new PkrError("PKR-POM-003", "Task has no governing Workflow");
    }
    const workflowId = ((workflowRelation.target as JsonObject).id as string);
    const workflow = this.getRecord("Workflow", workflowId);
    const manifest = this.getRecord("ProjectManifest", this.projectId).data;
    const roleId = (manifest.governance as JsonObject).ownerRoleId as string;
    const assignmentId = derivedId("assignment", `${commandId}:assignment`);
    const sessionId = derivedId("session", `${commandId}:session`);
    const leaseId = derivedId("lease", `${commandId}:lease`);
    const capabilityStatementId = derivedId("capability", `${commandId}:capability`);
    const runId = derivedId("run", `${commandId}:run`);
    const createdAt = now();
    const expiresAt = new Date(Date.now() + HOUR_MS).toISOString();
    const objective = (taskRecord.data.spec as JsonObject).objective as string;

    return this.mutate(commandId, command, (transaction) => {
      const ready = revisePom(taskRecord.data, taskRecord.revision + 1, {
        phase: "ready",
        reason: recovery ? "RecoveredForReassignment" : "ReadyForExecution",
        acceptanceResults: [],
      });
      this.contracts.validateObject(ready);
      transaction.putRecord("Task", taskId, taskRecord.revision, ready);
      transaction.appendEvent("pkr.task.phaseChanged", "Task", taskId, taskRecord.revision + 1, {
        from: taskPhase,
        to: "ready",
        ...(recoveryAssignment ? { recoveredFromAssignmentId: recoveryAssignment.id } : {}),
      });
      const inProgress = revisePom(ready, taskRecord.revision + 2, {
        phase: "inProgress",
        reason: "AssignmentRunning",
        acceptanceResults: [],
      });
      this.contracts.validateObject(inProgress);
      transaction.putRecord("Task", taskId, taskRecord.revision + 1, inProgress);
      transaction.appendEvent("pkr.task.phaseChanged", "Task", taskId, taskRecord.revision + 2, { from: "ready", to: "inProgress" });

      const capability: JsonObject = {
        apiVersion: "pkr.dev/v0.4",
        kind: "CapabilityStatement",
        capabilityStatementId,
        projectId: this.projectId,
        agentId,
        adapter: { id: adapterBinding.id, version: adapterBinding.version },
        protocolVersions: [adapterBinding.protocolVersion],
        capabilities: adapterBinding.capabilities,
        limits: { maxConcurrency: 1, maxDurationSeconds: 3600 },
        isolation: adapterBinding.isolation,
        issuedAt: createdAt,
        expiresAt,
        extensions: executionMode === "agent-native"
          ? {
              "pkr.agent-native/execution": {
                mode: "pull",
                locatorIsIdentity: false,
                locatorIsAuthority: false,
              },
            }
          : adapterBinding.adapterVersionId
          ? {
              "pkr.adapter/version": {
                adapterVersionId: adapterBinding.adapterVersionId,
                contentDigest: adapterBinding.contentDigest!,
              },
            }
          : {},
      };
      this.contracts.validateCoordination(capability);
      transaction.putRecord("CapabilityStatement", capabilityStatementId, 0, capability);
      transaction.appendEvent("pkr.agent.capabilitiesDeclared", "CapabilityStatement", capabilityStatementId, 1);

      const session: JsonObject = {
        apiVersion: "pkr.dev/v0.4",
        kind: "AgentSession",
        sessionId,
        projectId: this.projectId,
        revision: 1,
        projectSequence: transaction.currentSequence() + 1,
        createdAt,
        updatedAt: createdAt,
        agentId,
        sessionLocator: executionMode === "agent-native"
          ? options.sessionLocator ?? `agent-native://${sessionId}`
          : `adapter://${adapterBinding.id}/${sessionId}`,
        adapter: { id: adapterBinding.id, version: adapterBinding.version },
        protocolVersion: adapterBinding.protocolVersion,
        capabilityStatementId,
        assignmentIds: [assignmentId],
        state: "active",
        lastHeartbeat: createdAt,
        expiresAt,
        extensions: executionMode === "agent-native"
          ? {
              "pkr.agent-native/session": {
                mode: "pull",
                locator: options.sessionLocator ?? `agent-native://${sessionId}`,
                locatorIsIdentity: false,
                locatorIsAuthority: false,
                ...(options.repositoryBaseline ? { repositoryBaseline: options.repositoryBaseline } : {}),
              },
            }
          : adapterBinding.adapterVersionId
          ? {
              "pkr.adapter/version": {
                adapterVersionId: adapterBinding.adapterVersionId,
                contentDigest: adapterBinding.contentDigest!,
              },
            }
          : {},
      };
      this.contracts.validateCoordination(session);
      transaction.putRecord("AgentSession", sessionId, 0, session);
      transaction.appendEvent("pkr.agentSession.activated", "AgentSession", sessionId, 1);

      const run: JsonObject = {
        apiVersion: "pkr.dev/v0.4",
        kind: "WorkflowRun",
        runId,
        projectId: this.projectId,
        revision: 1,
        projectSequence: transaction.currentSequence() + 1,
        createdAt,
        updatedAt: createdAt,
        workflowId,
        workflowRevision: workflow.revision,
        scope: { type: "task", taskId },
        state: "implementing",
        activeSteps: ["implement"],
        completedSteps: ["plan"],
        pendingGates: ["test", "acceptance"],
        extensions: {
          "pkr.execution/mode": { mode: executionMode, assignmentId },
          ...(recoveryAssignment
            ? { "pkr.recovery/reassignment": { previousAssignmentId: recoveryAssignment.id } }
            : {}),
        },
      };
      this.contracts.validateCoordination(run);
      transaction.putRecord("WorkflowRun", runId, 0, run);
      transaction.appendEvent("pkr.workflowRun.started", "WorkflowRun", runId, 1);

      const assignmentBase: JsonObject = {
        apiVersion: "pkr.dev/v0.4",
        kind: "Assignment",
        assignmentId,
        projectId: this.projectId,
        revision: 1,
        projectSequence: transaction.currentSequence() + 1,
        createdAt,
        updatedAt: createdAt,
        idempotencyKey: commandId,
        taskId,
        taskRevision: taskRecord.revision + 2,
        workflowId,
        workflowRevision: workflow.revision,
        roleId,
        objective,
        allowedScope: ["**"],
        forbiddenScope: [".pkr/runtime.sqlite"],
        acceptanceRefs: [`${taskId}#task-accepted`],
        verificationPolicyRef: "pkr/default@1",
        requiredCapabilities: EXECUTION_REQUIRED_CAPABILITIES,
        expectedArtifacts: ["pkr/source-change"],
        callbackContract: {
          outcomes: ["verified", "partial", "blocked", "externalSignoffBlocked"],
          evidenceRequired: true,
        },
        state: "offered",
        extensions: {
          "pkr.execution/mode": { mode: executionMode, assignmentId },
          ...(recoveryAssignment
            ? { "pkr.recovery/reassignment": { previousAssignmentId: recoveryAssignment.id } }
            : {}),
        },
      };
      this.contracts.validateCoordination(assignmentBase);
      transaction.putRecord("Assignment", assignmentId, 0, assignmentBase);
      transaction.appendEvent("pkr.assignment.offered", "Assignment", assignmentId, 1);
      const accepted = reviseControl(assignmentBase, 2, transaction.currentSequence() + 1, { state: "accepted" });
      this.contracts.validateCoordination(accepted);
      transaction.putRecord("Assignment", assignmentId, 1, accepted);
      transaction.appendEvent("pkr.assignment.accepted", "Assignment", assignmentId, 2);

      const lease: JsonObject = {
        apiVersion: "pkr.dev/v0.4",
        kind: "Lease",
        leaseId,
        projectId: this.projectId,
        revision: 1,
        projectSequence: transaction.currentSequence() + 1,
        createdAt,
        updatedAt: createdAt,
        assignmentId,
        sessionId,
        agentId,
        scope: ["**"],
        mode: "exclusive",
        state: "active",
        acquiredAt: createdAt,
        expiresAt,
        heartbeatIntervalSeconds: 30,
        extensions: {},
      };
      this.contracts.validateCoordination(lease);
      transaction.putRecord("Lease", leaseId, 0, lease);
      transaction.appendEvent("pkr.lease.acquired", "Lease", leaseId, 1);
      const running = reviseControl(accepted, 3, transaction.currentSequence() + 1, { state: "running" });
      this.contracts.validateCoordination(running);
      transaction.putRecord("Assignment", assignmentId, 2, running);
      transaction.appendEvent("pkr.assignment.started", "Assignment", assignmentId, 3);

      return transaction.committed({
        taskId,
        assignmentId,
        sessionId,
        leaseId,
        workflowRunId: runId,
      });
    });
  }

  async callback(
    assignmentId: string,
    outcome: "verified" | "partial" | "blocked" | "externalSignoffBlocked",
    evidenceIds: string[] = [],
    commandId = newId("command"),
    workReport?: JsonObject,
    processEvidence?: JsonObject,
    workspaceEvidence?: JsonObject,
  ): Promise<CommandResult<JsonObject>> {
    const command = commandContent({
      action: "callback",
      assignmentId,
      outcome,
      evidenceIds,
      ...(workReport ? { workReport } : {}),
      ...(processEvidence ? { processEvidence } : {}),
      ...(workspaceEvidence ? { workspaceEvidence } : {}),
    });
    const replay = this.store.replay<JsonObject>(this.projectId, commandId, command);
    if (replay) {
      return replay;
    }
    const assignmentRecord = this.getRecord("Assignment", assignmentId);
    const assignment = assignmentRecord.data;
    if ((assignment.state as string) !== "running") {
      throw new PkrError("PKR-COORD-008", "callback requires a running Assignment");
    }
    const leaseRecord = this.listRecords("Lease").find(
      (record) => (record.data.assignmentId as string) === assignmentId,
    );
    if (!leaseRecord || !["active", "renewed"].includes(leaseRecord.data.state as string)) {
      throw new PkrError("PKR-COORD-008", "callback requires an active Lease");
    }
    const taskId = assignment.taskId as string;
    const taskRecord = this.getRecord("Task", taskId);
    const sessionId = leaseRecord.data.sessionId as string;
    const sessionRecord = this.getRecord("AgentSession", sessionId);
    if (sessionRecord.data.state !== "active" || this.executionExpired(sessionRecord, leaseRecord)) {
      await this.expireLease(
        leaseRecord.id,
        derivedId("command", `recovery:${this.projectId}:${leaseRecord.id}:${leaseRecord.data.expiresAt as string}`),
      );
      throw new PkrError("PKR-COORD-008", "callback rejected an expired execution");
    }
    const adapterVersionBinding = (sessionRecord.data.extensions as JsonObject)["pkr.adapter/version"] as
      JsonObject | undefined;
    if (adapterVersionBinding && !workReport) {
      throw new PkrError(
        "PKR-COORD-008",
        "managed Adapter callbacks require the complete work-report contract",
      );
    }
    if (workReport) {
      const callbackFailure = adapterCallbackFailure(workReport);
      if (
        callbackFailure ||
        workReport.outcome !== outcome ||
        JSON.stringify(workReport.evidenceIds) !== JSON.stringify(evidenceIds)
      ) {
        throw new PkrError(
          "PKR-COORD-008",
          `work report violates the active Adapter contract: ${callbackFailure ?? "BindingMismatch"}`,
        );
      }
    }
    if (processEvidence) {
      validateProcessEvidence(processEvidence);
      if (processEvidence.failureReason !== null || processEvidence.exitCode !== 0) {
        throw new PkrError(
          "PKR-COORD-008",
          "successful Adapter callback requires a successful process result",
        );
      }
    }
    if (adapterVersionBinding) {
      const adapter = this.readAdapterVersion(adapterVersionBinding.adapterVersionId as string);
      if (
        adapter.phase !== "active" ||
        adapter.contentDigest !== adapterVersionBinding.contentDigest
      ) {
        throw new PkrError(
          "PKR-COORD-008",
          "callback requires the AgentSession Adapter contract to remain active",
        );
      }
    }
    const runRecord = this.executionWorkflowRun(taskId, assignmentId);
    const messageId = derivedId("message", commandId);
    const issuedAt = now();

    return this.mutate(commandId, command, (transaction) => {
      const message: JsonObject = {
        apiVersion: "pkr.dev/v0.4",
        kind: "AgentMessage",
        messageId,
        projectId: this.projectId,
        type: "pkr.execution.callback",
        sender: { principalId: leaseRecord.data.agentId as string, sessionId },
        recipient: { component: "orchestrator" },
        assignmentId,
        leaseId: leaseRecord.id,
        correlationId: assignment.idempotencyKey as string,
        projectSequence: transaction.currentSequence(),
        issuedAt,
        payload: workReport ?? {
          outcome,
          evidenceIds,
          completed: [],
          incomplete: [],
          blockers: [],
          outputs: [],
          nextAction: "Run independent repository Verification.",
        },
        extensions: {
          ...(processEvidence ? { "pkr.provider/process": processEvidence } : {}),
          ...(workspaceEvidence ? { "pkr.workspace/evidence": workspaceEvidence } : {}),
        },
      };
      this.contracts.validateCoordination(message);
      transaction.putRecord("AgentMessage", messageId, 0, message);
      transaction.appendEvent("pkr.execution.callback", "AgentMessage", messageId, 1);

      const submitted = reviseControl(assignment, assignmentRecord.revision + 1, transaction.currentSequence() + 1, {
        state: "submitted",
        disposition: outcome,
      });
      this.contracts.validateCoordination(submitted);
      transaction.putRecord("Assignment", assignmentId, assignmentRecord.revision, submitted);
      transaction.appendEvent("pkr.assignment.submitted", "Assignment", assignmentId, assignmentRecord.revision + 1, { outcome });

      const verifying = revisePom(taskRecord.data, taskRecord.revision + 1, {
        phase: "verifying",
        reason: "CallbackSubmitted",
        acceptanceResults: [],
      });
      this.contracts.validateObject(verifying);
      transaction.putRecord("Task", taskId, taskRecord.revision, verifying);
      transaction.appendEvent("pkr.task.phaseChanged", "Task", taskId, taskRecord.revision + 1, { from: "inProgress", to: "verifying" });

      const released = reviseControl(leaseRecord.data, leaseRecord.revision + 1, transaction.currentSequence() + 1, { state: "released" });
      this.contracts.validateCoordination(released);
      transaction.putRecord("Lease", leaseRecord.id, leaseRecord.revision, released);
      transaction.appendEvent("pkr.lease.released", "Lease", leaseRecord.id, leaseRecord.revision + 1);
      const closing = reviseControl(
        sessionRecord.data,
        sessionRecord.revision + 1,
        transaction.currentSequence() + 1,
        { state: "closing" },
      );
      this.contracts.validateCoordination(closing);
      transaction.putRecord("AgentSession", sessionId, sessionRecord.revision, closing);
      transaction.appendEvent("pkr.agentSession.closing", "AgentSession", sessionId, sessionRecord.revision + 1);
      if (runRecord) {
        const verifyingRun = reviseControl(
          runRecord.data,
          runRecord.revision + 1,
          transaction.currentSequence() + 1,
          {
            state: "verifying",
            activeSteps: ["verify"],
            completedSteps: ["plan", "implement"],
          },
        );
        this.contracts.validateCoordination(verifyingRun);
        transaction.putRecord("WorkflowRun", runRecord.id, runRecord.revision, verifyingRun);
        transaction.appendEvent("pkr.workflowRun.transitioned", "WorkflowRun", runRecord.id, runRecord.revision + 1, { from: "implementing", to: "verifying" });
      }
      return transaction.committed({ assignmentId, messageId, taskId, outcome });
    });
  }

  async recordProviderFailure(
    assignmentId: string,
    processEvidence: JsonObject,
    workspaceEvidence: JsonObject,
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    validateProcessEvidence(processEvidence);
    if (processEvidence.failureReason === null) {
      throw new PkrError("PKR-COORD-006", "Provider failure requires a deterministic failure reason");
    }
    const command = commandContent({
      action: "recordProviderFailure",
      assignmentId,
      processEvidence,
      workspaceEvidence,
    });
    const replay = this.store.replay<JsonObject>(this.projectId, commandId, command);
    if (replay) {
      return replay;
    }
    const assignment = this.getRecord("Assignment", assignmentId);
    if (assignment.data.state !== "running") {
      throw new PkrError("PKR-COORD-006", "Provider failure requires a running Assignment");
    }
    const lease = this.listRecords("Lease").find(
      (record) => record.data.assignmentId === assignmentId,
    );
    if (!lease || !["active", "renewed"].includes(lease.data.state as string)) {
      throw new PkrError("PKR-COORD-006", "Provider failure requires an active Lease");
    }
    const taskId = assignment.data.taskId as string;
    const task = this.getRecord("Task", taskId);
    const session = this.getRecord("AgentSession", lease.data.sessionId as string);
    if (session.data.state !== "active" || this.executionExpired(session, lease)) {
      await this.expireLease(
        lease.id,
        derivedId("command", `recovery:${this.projectId}:${lease.id}:${lease.data.expiresAt as string}`),
      );
      throw new PkrError("PKR-COORD-006", "Provider failure rejected an expired execution");
    }
    const run = this.executionWorkflowRun(taskId, assignmentId);
    const messageId = derivedId("message", commandId);
    const failureReason = processEvidence.failureReason as string;
    const message: JsonObject = {
      apiVersion: "pkr.dev/v0.4",
      kind: "AgentMessage",
      messageId,
      projectId: this.projectId,
      type: "pkr.execution.callback",
      sender: { principalId: lease.data.agentId as string, sessionId: session.id },
      recipient: { component: "orchestrator" },
      assignmentId,
      leaseId: lease.id,
      correlationId: assignment.data.idempotencyKey as string,
      projectSequence: this.listEvents().at(-1)?.sequence ?? 1,
      issuedAt: now(),
      payload: {
        outcome: "blocked",
        evidenceIds: [],
        completed: [],
        incomplete: ["provider-execution"],
        blockers: [failureReason],
        outputs: [],
        nextAction: "Repair Provider configuration or retry through a new governed Assignment.",
      },
      extensions: {
        "pkr.provider/process": processEvidence,
        "pkr.workspace/evidence": workspaceEvidence,
      },
    };
    this.contracts.validateCoordination(message);
    return this.mutate(commandId, command, (transaction) => {
      transaction.putRecord("AgentMessage", messageId, 0, message);
      transaction.appendEvent("pkr.execution.providerFailed", "AgentMessage", messageId, 1, {
        assignmentId,
        failureReason,
      });
      const failedAssignment = reviseControl(
        assignment.data,
        assignment.revision + 1,
        transaction.currentSequence() + 1,
        { state: "failed", disposition: failureReason },
      );
      this.contracts.validateCoordination(failedAssignment);
      transaction.putRecord("Assignment", assignmentId, assignment.revision, failedAssignment);
      transaction.appendEvent("pkr.assignment.failed", "Assignment", assignmentId, assignment.revision + 1, {
        failureReason,
      });
      const blockedTask = revisePom(task.data, task.revision + 1, {
        phase: "blocked",
        reason: "ProviderExecutionFailed",
        acceptanceResults: [],
      });
      this.contracts.validateObject(blockedTask);
      transaction.putRecord("Task", taskId, task.revision, blockedTask);
      transaction.appendEvent("pkr.task.phaseChanged", "Task", taskId, task.revision + 1, {
        from: "inProgress",
        to: "blocked",
      });
      const releasedLease = reviseControl(
        lease.data,
        lease.revision + 1,
        transaction.currentSequence() + 1,
        { state: "released" },
      );
      this.contracts.validateCoordination(releasedLease);
      transaction.putRecord("Lease", lease.id, lease.revision, releasedLease);
      transaction.appendEvent("pkr.lease.released", "Lease", lease.id, lease.revision + 1, {
        failureReason,
      });
      const failedSession = reviseControl(
        session.data,
        session.revision + 1,
        transaction.currentSequence() + 1,
        { state: "failed" },
      );
      this.contracts.validateCoordination(failedSession);
      transaction.putRecord("AgentSession", session.id, session.revision, failedSession);
      transaction.appendEvent("pkr.agentSession.failed", "AgentSession", session.id, session.revision + 1, {
        failureReason,
      });
      if (run) {
        const blockedRun = reviseControl(
          run.data,
          run.revision + 1,
          transaction.currentSequence() + 1,
          {
            state: "blocked",
            activeSteps: [],
            pendingGates: run.data.pendingGates as JsonValue[],
          },
        );
        this.contracts.validateCoordination(blockedRun);
        transaction.putRecord("WorkflowRun", run.id, run.revision, blockedRun);
        transaction.appendEvent("pkr.workflowRun.transitioned", "WorkflowRun", run.id, run.revision + 1, {
          from: "implementing",
          to: "blocked",
        });
      }
      return transaction.committed({ assignmentId, taskId, messageId, failureReason });
    });
  }

  async verify(
    taskId: string,
    assignmentId: string,
    actorId = "agent_verifier",
    commandId = newId("command"),
    verificationEvidence?: JsonObject,
  ): Promise<CommandResult<JsonObject>> {
    if (!verificationEvidence) {
      throw new PkrError(
        "PKR-VERIFY-001",
        "Runtime acceptance requires formal evidence from the independent repository Verifier",
      );
    }
    const verdict = validateRepositoryVerificationEvidence(
      verificationEvidence,
      taskId,
      assignmentId,
      this.paths.root,
    );
    const command = commandContent({
      action: "verify",
      taskId,
      assignmentId,
      evidenceDigest: verdict.evidenceDigest,
    });
    const replay = this.store.replay<JsonObject>(this.projectId, commandId, command);
    if (replay) {
      return replay;
    }
    const taskRecord = this.getRecord("Task", taskId);
    const assignmentRecord = this.getRecord("Assignment", assignmentId);
    if ((taskRecord.data.status as JsonObject).phase !== "verifying") {
      throw new PkrError("PKR-POM-006", "Task must be verifying before completion");
    }
    if (assignmentRecord.data.state !== "submitted") {
      throw new PkrError("PKR-COORD-008", "submitted work result is required before Verification");
    }
    const leaseRecord = this.listRecords("Lease").find(
      (record) => record.data.assignmentId === assignmentId,
    );
    if (actorId === leaseRecord?.data.agentId) {
      throw new PkrError(
        "PKR-VERIFY-002",
        "Verifier must be distinct from the Agent that produced the work result",
      );
    }
    const artifactId = derivedId("artifact", `${commandId}:repository-evidence`);
    const testVerificationId = derivedId("verification", `${commandId}:test`);
    const acceptanceVerificationId = derivedId("verification", `${commandId}:acceptance`);
    const sessionRecord = leaseRecord
      ? this.store.getRecord(
          this.projectId,
          "AgentSession",
          leaseRecord.data.sessionId as string,
        )
      : undefined;
    const runRecord = this.executionWorkflowRun(taskId, assignmentId);
    const artifact = repositoryVerificationArtifactObject({
      id: artifactId,
      projectId: this.projectId,
      taskId,
      digest: verdict.evidenceDigest,
      commandId,
      createdBy: actorId,
    });
    artifact.extensions = {
      "pkr.verification/repository": verificationEvidence,
    };
    const testVerification = verificationObject({
      id: testVerificationId,
      projectId: this.projectId,
      taskId,
      taskRevision: taskRecord.revision,
      artifactId,
      createdBy: actorId,
      gate: "test",
      passed: verdict.passed,
      methodAdapter: "pkr/local-repository-verifier",
      methodVersion: "0.8.0",
      evidenceType: "pkr/repository-verification",
      evidenceDigest: verdict.evidenceDigest,
    });
    const acceptanceVerification = verdict.passed ? verificationObject({
      id: acceptanceVerificationId,
      projectId: this.projectId,
      taskId,
      taskRevision: taskRecord.revision,
      artifactId,
      createdBy: actorId,
      gate: "acceptance",
      methodAdapter: "pkr/local-repository-verifier",
      methodVersion: "0.8.0",
      evidenceType: "pkr/repository-verification",
      evidenceDigest: verdict.evidenceDigest,
    }) : undefined;
    this.contracts.validateObject(artifact);
    this.contracts.validateObject(testVerification);
    if (acceptanceVerification) {
      this.contracts.validateObject(acceptanceVerification);
    }

    return this.mutate<JsonObject>(commandId, command, (transaction) => {
      transaction.putRecord("Artifact", artifactId, 0, artifact);
      transaction.appendEvent("pkr.artifact.available", "Artifact", artifactId, 1, {
        artifactType: "pkr/repository-verification",
        evidenceDigest: verdict.evidenceDigest,
      });
      transaction.putRecord("Verification", testVerificationId, 0, testVerification);
      transaction.appendEvent(
        verdict.passed ? "pkr.verification.passed" : "pkr.verification.failed",
        "Verification",
        testVerificationId,
        1,
        { gate: "test", evidenceDigest: verdict.evidenceDigest },
      );

      const relations = [...(taskRecord.data.relations as JsonValue[])];
      relations.push({
        type: "produces",
        target: { kind: "Artifact", id: artifactId },
        required: true,
      });
      if (!verdict.passed) {
        const blocked = revisePom(
          { ...taskRecord.data, relations },
          taskRecord.revision + 1,
          {
            phase: "blocked",
            reason: "VerificationFailed",
            acceptanceResults: [{
              criterionId: "task-accepted",
              result: "unsatisfied",
              evidenceDigests: [verdict.evidenceDigest],
            }],
          },
        );
        this.contracts.validateObject(blocked);
        transaction.putRecord("Task", taskId, taskRecord.revision, blocked);
        transaction.appendEvent("pkr.task.phaseChanged", "Task", taskId, taskRecord.revision + 1, {
          from: "verifying",
          to: "blocked",
        });
        const failedAssignment = reviseControl(
          assignmentRecord.data,
          assignmentRecord.revision + 1,
          transaction.currentSequence() + 1,
          { state: "failed", disposition: "VerificationFailed" },
        );
        this.contracts.validateCoordination(failedAssignment);
        transaction.putRecord("Assignment", assignmentId, assignmentRecord.revision, failedAssignment);
        transaction.appendEvent("pkr.assignment.failed", "Assignment", assignmentId, assignmentRecord.revision + 1, {
          reason: "VerificationFailed",
        });
        if (sessionRecord && sessionRecord.data.state === "closing") {
          const failedSession = reviseControl(
            sessionRecord.data,
            sessionRecord.revision + 1,
            transaction.currentSequence() + 1,
            { state: "failed" },
          );
          this.contracts.validateCoordination(failedSession);
          transaction.putRecord("AgentSession", sessionRecord.id, sessionRecord.revision, failedSession);
          transaction.appendEvent("pkr.agentSession.failed", "AgentSession", sessionRecord.id, sessionRecord.revision + 1, {
            reason: "VerificationFailed",
          });
        }
        if (runRecord) {
          const blockedRun = reviseControl(
            runRecord.data,
            runRecord.revision + 1,
            transaction.currentSequence() + 1,
            { state: "blocked", activeSteps: [], pendingGates: ["test", "acceptance"] },
          );
          this.contracts.validateCoordination(blockedRun);
          transaction.putRecord("WorkflowRun", runRecord.id, runRecord.revision, blockedRun);
          transaction.appendEvent("pkr.workflowRun.transitioned", "WorkflowRun", runRecord.id, runRecord.revision + 1, {
            from: "verifying",
            to: "blocked",
          });
        }
        return transaction.committed({
          taskId,
          assignmentId,
          artifactId,
          verificationIds: [testVerificationId],
          passed: false,
        });
      }

      transaction.putRecord("Verification", acceptanceVerificationId, 0, acceptanceVerification!);
      transaction.appendEvent("pkr.verification.passed", "Verification", acceptanceVerificationId, 1, {
        gate: "acceptance",
        evidenceDigest: verdict.evidenceDigest,
      });

      const done = revisePom(
        { ...taskRecord.data, relations },
        taskRecord.revision + 1,
        {
          phase: "done",
          reason: "VerificationPassed",
          acceptanceResults: [
            {
              criterionId: "task-accepted",
              result: "satisfied",
              evidenceDigests: [verdict.evidenceDigest],
            },
          ],
        },
      );
      this.contracts.validateObject(done);
      transaction.putRecord("Task", taskId, taskRecord.revision, done);
      transaction.appendEvent("pkr.task.phaseChanged", "Task", taskId, taskRecord.revision + 1, { from: "verifying", to: "done" });
      const closed = reviseControl(assignmentRecord.data, assignmentRecord.revision + 1, transaction.currentSequence() + 1, { state: "closed", disposition: "verified" });
      this.contracts.validateCoordination(closed);
      transaction.putRecord("Assignment", assignmentId, assignmentRecord.revision, closed);
      transaction.appendEvent("pkr.assignment.closed", "Assignment", assignmentId, assignmentRecord.revision + 1);
      if (sessionRecord && sessionRecord.data.state === "closing") {
        const closedSession = reviseControl(
          sessionRecord.data,
          sessionRecord.revision + 1,
          transaction.currentSequence() + 1,
          { state: "closed" },
        );
        this.contracts.validateCoordination(closedSession);
        transaction.putRecord("AgentSession", sessionRecord.id, sessionRecord.revision, closedSession);
        transaction.appendEvent("pkr.agentSession.closed", "AgentSession", sessionRecord.id, sessionRecord.revision + 1);
      }
      if (runRecord) {
        const completedRun = reviseControl(
          runRecord.data,
          runRecord.revision + 1,
          transaction.currentSequence() + 1,
          {
            state: "done",
            activeSteps: [],
            completedSteps: ["plan", "implement", "verify"],
            pendingGates: [],
          },
        );
        this.contracts.validateCoordination(completedRun);
        transaction.putRecord("WorkflowRun", runRecord.id, runRecord.revision, completedRun);
        transaction.appendEvent("pkr.workflowRun.transitioned", "WorkflowRun", runRecord.id, runRecord.revision + 1, { from: "verifying", to: "done" });
      }
      return transaction.committed({
        taskId,
        assignmentId,
        artifactId,
        verificationIds: [testVerificationId, acceptanceVerificationId],
        passed: true,
      });
    });
  }

  workspace(
    taskId: string,
    assignmentId: string,
    principalId: string,
    repositoryEvidence?: JsonObject,
  ): JsonObject {
    const task = this.getRecord("Task", taskId);
    const assignment = this.getRecord("Assignment", assignmentId);
    const lease = this.listRecords("Lease").find(
      (record) => record.data.assignmentId === assignmentId,
    );
    const session = lease
      ? this.store.getRecord(this.projectId, "AgentSession", lease.data.sessionId as string)
      : undefined;
    if (
      assignment.data.taskId !== taskId ||
      assignment.data.state !== "running" ||
      !lease ||
      !["active", "renewed"].includes(lease.data.state as string) ||
      lease.data.agentId !== principalId ||
      !session ||
      session.data.state !== "active" ||
      this.executionExpired(session, lease)
    ) {
      throw new PkrError("PKR-COORD-006", "Workspace requires one live Assignment, Session, and Lease binding");
    }
    const goalRelation = (task.data.relations as JsonValue[]).find(
      (relation) => (relation as JsonObject).type === "contributesTo",
    ) as JsonObject;
    const workflowRelation = (task.data.relations as JsonValue[]).find(
      (relation) => (relation as JsonObject).type === "governedBy",
    ) as JsonObject;
    const goalId = (goalRelation.target as JsonObject).id as string;
    const goal = this.getRecord("Goal", goalId);
    const missionRelation = (goal.data.relations as JsonValue[]).find(
      (relation) => (relation as JsonObject).type === "contributesTo",
    ) as JsonObject;
    const missionId = (missionRelation.target as JsonObject).id as string;
    const workflowId = (workflowRelation.target as JsonObject).id as string;
    const manifest = this.getRecord("ProjectManifest", this.projectId).data;
    const roleId = (manifest.governance as JsonObject).ownerRoleId as string;
    const sequence = this.listEvents().at(-1)?.sequence ?? 0;
    const createdAt = now();
    const workspace: JsonObject = {
      apiVersion: "pkr.dev/v0.4",
      kind: "Workspace",
      workspaceId: newId("workspace"),
      projectId: this.projectId,
      principalId,
      roleId,
      projectSequence: sequence,
      createdAt,
      expiresAt: new Date(Date.now() + WORKSPACE_MS).toISOString(),
      context: {
        mission: { kind: "Mission", id: missionId, revision: this.getRecord("Mission", missionId).revision },
        goal: { kind: "Goal", id: goalId, revision: goal.revision },
        task: { kind: "Task", id: taskId, revision: task.revision },
        workflow: { kind: "Workflow", id: workflowId, revision: this.getRecord("Workflow", workflowId).revision },
        assignment: { kind: "Assignment", id: assignmentId, revision: assignment.revision },
        constraints: [],
        decisions: [],
        artifacts: this.listRecords("Artifact").map((record) => ({ kind: "Artifact", id: record.id, revision: record.revision })),
      },
      permittedActions: ["submitAgentMessage"],
      forbiddenActions: ["updateManifest"],
      memoryEntryIds: this.listRecords("MemoryEntry").map((record) => record.id),
      notices: repositoryEvidence ? [] : [{
        type: "omitted",
        message: "Real Git repository evidence was not collected for this Workspace.",
      }],
      extensions: repositoryEvidence
        ? { "pkr.workspace/repository": repositoryEvidence }
        : {},
    };
    this.contracts.validateCoordination(workspace);
    return workspace;
  }

  async heartbeat(
    sessionId: string,
    leaseId: string,
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    const command = commandContent({ action: "heartbeat", sessionId, leaseId });
    const replay = this.store.replay<JsonObject>(this.projectId, commandId, command);
    if (replay) {
      return replay;
    }
    const session = this.getRecord("AgentSession", sessionId);
    const lease = this.getRecord("Lease", leaseId);
    if (session.data.state !== "active" || !["active", "renewed"].includes(lease.data.state as string)) {
      throw new PkrError("PKR-COORD-006", "heartbeat requires active Session and Lease");
    }
    if (lease.data.sessionId !== sessionId) {
      throw new PkrError("PKR-COORD-006", "heartbeat Session and Lease binding does not match");
    }
    if (this.executionExpired(session, lease)) {
      await this.expireLease(
        leaseId,
        derivedId("command", `recovery:${this.projectId}:${leaseId}:${lease.data.expiresAt as string}`),
      );
      throw new PkrError("PKR-COORD-006", "heartbeat rejected an expired execution");
    }
    return this.mutate(commandId, command, (transaction) => {
      const observedAt = now();
      const expiresAt = new Date(Date.now() + HOUR_MS).toISOString();
      const nextSession = reviseControl(
        session.data,
        session.revision + 1,
        transaction.currentSequence() + 1,
        { lastHeartbeat: observedAt, expiresAt },
      );
      this.contracts.validateCoordination(nextSession);
      transaction.putRecord("AgentSession", sessionId, session.revision, nextSession);
      transaction.appendEvent("pkr.execution.heartbeat", "AgentSession", sessionId, session.revision + 1);
      const nextLease = reviseControl(
        lease.data,
        lease.revision + 1,
        transaction.currentSequence() + 1,
        { state: "renewed", expiresAt },
      );
      this.contracts.validateCoordination(nextLease);
      transaction.putRecord("Lease", leaseId, lease.revision, nextLease);
      transaction.appendEvent("pkr.lease.renewed", "Lease", leaseId, lease.revision + 1);
      return transaction.committed({ sessionId, leaseId, observedAt, expiresAt });
    });
  }

  async cancelAssignment(
    assignmentId: string,
    reason: string,
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    const command = commandContent({ action: "cancelAssignment", assignmentId, reason });
    const replay = this.store.replay<JsonObject>(this.projectId, commandId, command);
    if (replay) {
      return replay;
    }
    const assignment = this.getRecord("Assignment", assignmentId);
    if (["closed", "cancelled", "expired", "failed", "rejected"].includes(assignment.data.state as string)) {
      throw new PkrError("PKR-COORD-004", "Assignment is already terminal");
    }
    const lease = this.listRecords("Lease").find(
      (record) => record.data.assignmentId === assignmentId,
    );
    const session = lease
      ? this.store.getRecord(this.projectId, "AgentSession", lease.data.sessionId as string)
      : undefined;
    const taskId = assignment.data.taskId as string;
    const task = this.getRecord("Task", taskId);
    return this.mutate(commandId, command, (transaction) => {
      const cancelled = reviseControl(
        assignment.data,
        assignment.revision + 1,
        transaction.currentSequence() + 1,
        { state: "cancelled", disposition: reason },
      );
      this.contracts.validateCoordination(cancelled);
      transaction.putRecord("Assignment", assignmentId, assignment.revision, cancelled);
      transaction.appendEvent("pkr.assignment.cancelled", "Assignment", assignmentId, assignment.revision + 1, { reason });
      if (lease && ["active", "renewed"].includes(lease.data.state as string)) {
        const revoked = reviseControl(
          lease.data,
          lease.revision + 1,
          transaction.currentSequence() + 1,
          { state: "revoked" },
        );
        this.contracts.validateCoordination(revoked);
        transaction.putRecord("Lease", lease.id, lease.revision, revoked);
        transaction.appendEvent("pkr.lease.revoked", "Lease", lease.id, lease.revision + 1, { reason });
      }
      if (session && session.data.state === "active") {
        const closed = reviseControl(
          session.data,
          session.revision + 1,
          transaction.currentSequence() + 1,
          { state: "closed" },
        );
        this.contracts.validateCoordination(closed);
        transaction.putRecord("AgentSession", session.id, session.revision, closed);
        transaction.appendEvent("pkr.agentSession.closed", "AgentSession", session.id, session.revision + 1, { reason });
      }
      const taskPhase = (task.data.status as JsonObject).phase as string;
      if (["ready", "inProgress", "blocked", "verifying"].includes(taskPhase)) {
        const cancelledTask = revisePom(task.data, task.revision + 1, {
          phase: "cancelled",
          reason: "AssignmentCancelled",
          acceptanceResults: (task.data.status as JsonObject).acceptanceResults as JsonValue[],
        });
        this.contracts.validateObject(cancelledTask);
        transaction.putRecord("Task", taskId, task.revision, cancelledTask);
        transaction.appendEvent("pkr.task.phaseChanged", "Task", taskId, task.revision + 1, { from: taskPhase, to: "cancelled" });
      }
      return transaction.committed({ assignmentId, taskId, reason });
    });
  }

  async expireLease(
    leaseId: string,
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    const command = commandContent({ action: "expireLease", leaseId });
    const replay = this.store.replay<JsonObject>(this.projectId, commandId, command);
    if (replay) {
      return replay;
    }
    const lease = this.getRecord("Lease", leaseId);
    if (!["active", "renewed"].includes(lease.data.state as string)) {
      throw new PkrError("PKR-COORD-004", "only an active Lease can expire");
    }
    const assignmentId = lease.data.assignmentId as string;
    const assignment = this.getRecord("Assignment", assignmentId);
    const session = this.getRecord("AgentSession", lease.data.sessionId as string);
    const task = this.getRecord("Task", assignment.data.taskId as string);
    if (assignment.data.state !== "running" || session.data.state !== "active") {
      throw new PkrError(
        "PKR-RECOVERY-001",
        "active Lease is inconsistent with its Assignment or AgentSession",
        "conflict",
      );
    }
    return this.mutate(commandId, command, (transaction) => {
      const expiredLease = reviseControl(
        lease.data,
        lease.revision + 1,
        transaction.currentSequence() + 1,
        { state: "expired" },
      );
      this.contracts.validateCoordination(expiredLease);
      transaction.putRecord("Lease", leaseId, lease.revision, expiredLease);
      transaction.appendEvent("pkr.lease.expired", "Lease", leaseId, lease.revision + 1);
      const expiredAssignment = reviseControl(
        assignment.data,
        assignment.revision + 1,
        transaction.currentSequence() + 1,
        { state: "expired", disposition: "LeaseExpired" },
      );
      this.contracts.validateCoordination(expiredAssignment);
      transaction.putRecord("Assignment", assignmentId, assignment.revision, expiredAssignment);
      transaction.appendEvent("pkr.assignment.expired", "Assignment", assignmentId, assignment.revision + 1);
      const expiredSession = reviseControl(
        session.data,
        session.revision + 1,
        transaction.currentSequence() + 1,
        { state: "expired" },
      );
      this.contracts.validateCoordination(expiredSession);
      transaction.putRecord("AgentSession", session.id, session.revision, expiredSession);
      transaction.appendEvent("pkr.agentSession.expired", "AgentSession", session.id, session.revision + 1);
      const taskStatus = task.data.status as JsonObject;
      const blockedTask = revisePom(task.data, task.revision + 1, {
        phase: "blocked",
        reason: "LeaseExpired",
        acceptanceResults: taskStatus.acceptanceResults as JsonValue[],
      });
      this.contracts.validateObject(blockedTask);
      transaction.putRecord("Task", task.id, task.revision, blockedTask);
      transaction.appendEvent("pkr.task.phaseChanged", "Task", task.id, task.revision + 1, { from: taskStatus.phase as string, to: "blocked" });
      const run = this.executionWorkflowRun(task.id, assignmentId);
      if (run && run.data.state === "implementing") {
        const interruptedRun = reviseControl(
          run.data,
          run.revision + 1,
          transaction.currentSequence() + 1,
          { state: "blocked", activeSteps: [], pendingGates: run.data.pendingGates as JsonValue[] },
        );
        this.contracts.validateCoordination(interruptedRun);
        transaction.putRecord("WorkflowRun", run.id, run.revision, interruptedRun);
        transaction.appendEvent(
          "pkr.workflowRun.transitioned",
          "WorkflowRun",
          run.id,
          run.revision + 1,
          { from: "implementing", to: "blocked", reason: "LeaseExpired" },
        );
      }
      return transaction.committed({ leaseId, assignmentId, taskId: task.id });
    });
  }

  async recoverInterruptedSessions(observedAt = now()): Promise<JsonObject> {
    const observedTime = Date.parse(observedAt);
    if (!Number.isFinite(observedTime)) {
      throw new PkrError("PKR-RECOVERY-001", "recovery observation time is invalid");
    }
    const expired: string[] = [];
    const liveLeases = this.listRecords("Lease")
      .filter((lease) => ["active", "renewed"].includes(lease.data.state as string))
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const lease of liveLeases) {
      const expiresAt = Date.parse(lease.data.expiresAt as string);
      const session = this.getRecord("AgentSession", lease.data.sessionId as string);
      const sessionExpiresAt = Date.parse(session.data.expiresAt as string);
      const assignment = this.getRecord("Assignment", lease.data.assignmentId as string);
      if (!Number.isFinite(expiresAt) || !Number.isFinite(sessionExpiresAt)) {
        throw new PkrError("PKR-RECOVERY-001", `Lease ${lease.id} has an invalid expiry timestamp`);
      }
      if (session.data.state !== "active" || assignment.data.state !== "running") {
        throw new PkrError(
          "PKR-RECOVERY-001",
          `Lease ${lease.id} is live but its Session or Assignment is not`,
          "conflict",
        );
      }
      if (Math.min(expiresAt, sessionExpiresAt) <= observedTime) {
        await this.expireLease(
          lease.id,
          derivedId("command", `recovery:${this.projectId}:${lease.id}:${lease.data.expiresAt as string}`),
        );
        expired.push(lease.id);
      }
    }
    return {
      observedAt,
      expiredLeaseIds: expired,
      pendingExternalEffectIds: this.store
        .listExternalEffects(this.projectId)
        .filter((effect) => effect.state === "pending")
        .map((effect) => effect.effectId),
    };
  }

  beginExternalEffect(
    assignmentId: string,
    effectId: string,
    request: JsonObject,
  ): JsonObject {
    const assignment = this.getRecord("Assignment", assignmentId);
    const lease = this.listRecords("Lease").find(
      (record) => record.data.assignmentId === assignmentId,
    );
    if (
      assignment.data.state !== "running" ||
      !lease ||
      !["active", "renewed"].includes(lease.data.state as string) ||
      this.executionExpired(
        this.getRecord("AgentSession", lease.data.sessionId as string),
        lease,
      )
    ) {
      throw new PkrError("PKR-RECOVERY-003", "external effects require a running Assignment and live Lease");
    }
    const reserved = this.store.beginExternalEffect(
      this.projectId,
      effectId,
      assignmentId,
      commandContent(request),
    );
    return {
      effectId,
      assignmentId,
      state: reserved.effect.state,
      execute: reserved.execute,
      ...(reserved.effect.result ? { result: reserved.effect.result } : {}),
    };
  }

  completeExternalEffect(
    effectId: string,
    state: "succeeded" | "failed",
    result: JsonObject,
  ): JsonObject {
    const completed = this.store.finishExternalEffect(
      this.projectId,
      effectId,
      state,
      commandContent(result),
    );
    return {
      effectId,
      state: completed.effect.state,
      changed: completed.changed,
      result: completed.effect.result,
    };
  }

  externalEffect(effectId: string): JsonObject | undefined {
    const effect = this.store.getExternalEffect(this.projectId, effectId);
    return effect as unknown as JsonObject | undefined;
  }

  async deriveMemory(
    summary: string,
    sources: Array<{ kind: string; id: string; revision: number }>,
    visibility = "project",
    actorId = this.ownerId(),
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    if (!summary.trim() || sources.length === 0) {
      throw new PkrError("PKR-MEMORY-001", "Memory requires a summary and at least one source");
    }
    if (!/^(project|public|principal:[a-zA-Z0-9._-]+|role:[a-zA-Z0-9._-]+)$/.test(visibility)) {
      throw new PkrError("PKR-MEMORY-002", `unsupported Memory visibility ${visibility}`);
    }
    for (const source of sources) {
      const record = this.getRecord(source.kind, source.id);
      if (record.revision !== source.revision) {
        throw new PkrError(
          "PKR-MEMORY-001",
          `${source.kind}/${source.id} revision ${source.revision} is not current`,
          "conflict",
        );
      }
    }
    const memoryId = derivedId("memory", commandId);
    const createdAt = now();
    const currentSequence = this.listEvents().at(-1)?.sequence ?? 1;
    const sourceEvents = this.listEvents().filter((event) =>
      sources.some((source) => source.kind === event.subjectKind && source.id === event.subjectId),
    );
    const memory: JsonObject = {
      apiVersion: "pkr.dev/v0.4",
      kind: "MemoryEntry",
      memoryId,
      projectId: this.projectId,
      class: "semantic",
      summary: summary.trim(),
      derived: true,
      sourceRefs: sources as unknown as JsonValue,
      eventRanges: sourceEvents.length > 0
        ? [{ firstSequence: sourceEvents[0]!.sequence, lastSequence: sourceEvents.at(-1)!.sequence }]
        : [],
      derivation: { method: "pkr.memory.deterministic-summary", version: "0.7.0" },
      confidence: 1,
      retentionClass: "project",
      visibility,
      projectSequence: currentSequence,
      createdAt,
      validUntil: null,
      invalidatedAt: null,
      invalidationReason: null,
      extensions: {},
    };
    this.contracts.validateCoordination(memory);
    return this.mutate(
      commandId,
      { action: "deriveMemory", memoryId, summary: summary.trim(), sources: sources as unknown as JsonValue, visibility },
      (transaction) => {
        transaction.putRecord("MemoryEntry", memoryId, 0, memory);
        transaction.appendEvent("pkr.memory.derived", "MemoryEntry", memoryId, 1, {
          sourceCount: sources.length,
        });
        return transaction.committed(memory);
      },
    );
  }

  async reconcileMemorySources(): Promise<void> {
    const records = new Map(
      this.listRecords().map((record) => [`${record.kind}/${record.id}`, record]),
    );
    for (const memory of this.listRecords("MemoryEntry")) {
      if (memory.data.invalidatedAt !== null) {
        continue;
      }
      const sources = memory.data.sourceRefs as JsonObject[];
      const stale = sources.find((source) => {
        const current = records.get(`${source.kind as string}/${source.id as string}`);
        return !current || current.revision !== source.revision;
      });
      if (!stale) {
        continue;
      }
      const current = records.get(`${stale.kind as string}/${stale.id as string}`);
      const reason = current ? "SourceSuperseded" : "SourceMissing";
      const commandId = derivedId(
        "command",
        `memory-invalidate:${memory.id}:${memory.revision}:${reason}`,
      );
      await this.mutate(
        commandId,
        { action: "invalidateMemory", memoryId: memory.id, reason },
        (transaction) => {
          const changed: JsonObject = {
            ...memory.data,
            invalidatedAt: now(),
            invalidationReason: reason,
          };
          this.contracts.validateCoordination(changed);
          transaction.putRecord("MemoryEntry", memory.id, memory.revision, changed);
          transaction.appendEvent(
            "pkr.memory.invalidated",
            "MemoryEntry",
            memory.id,
            memory.revision + 1,
            { reason },
          );
          return transaction.committed({ memoryId: memory.id, reason });
        },
      );
    }
  }

  listMemory(principalId: string, roleNames: string[] = []): StoredRecord[] {
    const timestamp = Date.now();
    return this.listRecords("MemoryEntry").filter((record) => {
      const visibility = record.data.visibility as string;
      const validUntil = record.data.validUntil as string | null;
      return record.data.invalidatedAt === null &&
        (!validUntil || Date.parse(validUntil) > timestamp) &&
        (visibility === "project" ||
          visibility === "public" ||
          visibility === `principal:${principalId}` ||
          (visibility.startsWith("role:") && roleNames.includes(visibility.slice(5))));
    });
  }

  async promoteMemory(
    memoryId: string,
    title: string,
    actorId = this.ownerId(),
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    await this.reconcileMemorySources();
    const memory = this.getRecord("MemoryEntry", memoryId);
    if (memory.data.invalidatedAt !== null) {
      throw new PkrError("PKR-MEMORY-003", "invalidated Memory cannot be promoted");
    }
    const knowledgeId = derivedId("knowledge", commandId);
    const knowledge = knowledgeObject({
      id: knowledgeId,
      projectId: this.projectId,
      title,
      content: memory.data.summary as string,
      sourceUri: `pkr://${this.projectId}/memory/${memoryId}`,
      createdBy: actorId,
    });
    knowledge.extensions = { "pkr.memory/source": { memoryId, revision: memory.revision } };
    this.contracts.validateObject(knowledge);
    return this.mutate(
      commandId,
      { action: "promoteMemory", memoryId, knowledgeId, title },
      (transaction) => {
        transaction.putRecord("Knowledge", knowledgeId, 0, knowledge);
        transaction.appendEvent("pkr.knowledge.created", "Knowledge", knowledgeId, 1, {
          memoryId,
        });
        return transaction.committed(knowledge);
      },
    );
  }

  async registerPrompt(
    title: string,
    template: string,
    version = "1.0.0",
    actorId = this.ownerId(),
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    if (
      !title.trim() ||
      title.length > 256 ||
      !template.trim() ||
      template.length > 10000 ||
      !version.trim() ||
      version.length > 128
    ) {
      throw new PkrError(
        "PKR-EVOLUTION-008",
        "Prompt registration requires a title, version, and template of at most 10000 characters",
      );
    }
    const variables = promptTemplateVariables(template);
    const promptId = derivedId("prompt", commandId);
    const contentDigest = digest(template);
    const prompt = knowledgeObject({
      id: promptId,
      projectId: this.projectId,
      title: title.trim(),
      content: template,
      sourceUri: `pkr://${this.projectId}/prompt/${promptId}`,
      sourceDigest: contentDigest,
      createdBy: actorId,
      knowledgeType: "prompt",
    });
    prompt.extensions = {
      "pkr.prompt/version": {
        version: version.trim(),
        contentDigest,
        state: "active",
        variables,
      },
    };
    this.contracts.validateObject(prompt);
    return this.mutate(
      commandId,
      { action: "registerPrompt", promptId, title: title.trim(), template, version: version.trim() },
      (transaction) => {
        transaction.putRecord("Knowledge", promptId, 0, prompt);
        transaction.appendEvent("pkr.prompt.registered", "Knowledge", promptId, 1, {
          version: version.trim(),
          contentDigest,
          variables,
        });
        return transaction.committed(prompt);
      },
    );
  }

  promptStatus(promptId: string): JsonObject {
    const prompt = this.readPromptVersion(promptId);
    return {
      promptId,
      revision: prompt.record.revision,
      version: prompt.version,
      contentDigest: prompt.contentDigest,
      phase: prompt.phase,
      active: prompt.phase === "active",
      supersedes: (prompt.record.data.relations as JsonObject[])
        .filter((relation) => relation.type === "supersedes")
        .map((relation) => (relation.target as JsonObject).id as string),
    };
  }

  async rollbackPrompt(
    currentPromptId: string,
    targetPromptId: string,
    actorId = this.ownerId(),
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    if (actorId !== this.ownerId()) {
      throw new PkrError("PKR-EVOLUTION-002", "Prompt rollback requires the Project owner");
    }
    const current = this.readPromptVersion(currentPromptId);
    const target = this.readPromptVersion(targetPromptId);
    const directlySupersedes = (current.record.data.relations as JsonObject[]).some((relation) =>
      relation.type === "supersedes" &&
      (relation.target as JsonObject).kind === "Knowledge" &&
      (relation.target as JsonObject).id === targetPromptId,
    );
    if (current.phase !== "active" || target.phase !== "deprecated" || !directlySupersedes) {
      throw new PkrError(
        "PKR-EVOLUTION-009",
        "Prompt rollback requires an active version and its directly superseded prior version",
      );
    }
    const deprecated = revisePom(current.record.data, current.record.revision + 1, {
      phase: "deprecated",
      reason: "PromptRolledBack",
    });
    deprecated.extensions = {
      ...(deprecated.extensions as JsonObject),
      "pkr.prompt/version": {
        ...((deprecated.extensions as JsonObject)["pkr.prompt/version"] as JsonObject),
        state: "deprecated",
      },
    };
    const restored = revisePom(target.record.data, target.record.revision + 1, {
      phase: "active",
      reason: "PromptRollbackRestored",
    });
    restored.extensions = {
      ...(restored.extensions as JsonObject),
      "pkr.prompt/version": {
        ...((restored.extensions as JsonObject)["pkr.prompt/version"] as JsonObject),
        state: "active",
      },
    };
    this.contracts.validateObject(deprecated);
    this.contracts.validateObject(restored);
    return this.mutate(
      commandId,
      { action: "rollbackPrompt", currentPromptId, targetPromptId, actorId },
      (transaction) => {
        transaction.putRecord("Knowledge", currentPromptId, current.record.revision, deprecated);
        transaction.appendEvent(
          "pkr.prompt.deprecated",
          "Knowledge",
          currentPromptId,
          current.record.revision + 1,
          { reason: "Rollback", restored: targetPromptId },
        );
        transaction.putRecord("Knowledge", targetPromptId, target.record.revision, restored);
        transaction.appendEvent(
          "pkr.prompt.rolledBack",
          "Knowledge",
          targetPromptId,
          target.record.revision + 1,
          { from: currentPromptId },
        );
        return transaction.committed({
          promptId: targetPromptId,
          replaced: currentPromptId,
          contentDigest: target.contentDigest,
        });
      },
    );
  }

  async registerPolicy(
    policy: GovernancePolicyContent,
    actorId = this.ownerId(),
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    if (actorId !== this.ownerId()) {
      throw new PkrError("PKR-EVOLUTION-002", "Policy registration requires the Project owner");
    }
    const content = JSON.parse(JSON.stringify(policy)) as unknown as GovernancePolicyContent;
    validateGovernancePolicy(content);
    const active = this.listRecords("Constraint").filter((record) => {
      const extension = (record.data.extensions as JsonObject)["pkr.policy/version"] as JsonObject | undefined;
      return extension?.state === "active";
    });
    if (active.length !== 0) {
      throw new PkrError(
        "PKR-EVOLUTION-010",
        "Policy registration is limited to the first active governance baseline",
        "conflict",
      );
    }
    const policyId = derivedId("constraint", `${commandId}:policy`);
    const contentDigest = digest(content);
    const constraint = constraintObject({
      id: policyId,
      projectId: this.projectId,
      title: content.title,
      rule: content.rule,
      scopeKinds: content.scopeKinds,
      severity: content.severity,
      enforcement: content.enforcement,
      createdBy: actorId,
    });
    constraint.extensions = {
      "pkr.policy/version": {
        version: content.version,
        contentDigest,
        state: "active",
        content: content as unknown as JsonObject,
      },
    };
    this.contracts.validateObject(constraint);
    return this.mutate(
      commandId,
      { action: "registerPolicy", policyId, contentDigest, policy: content as unknown as JsonObject },
      (transaction) => {
        transaction.putRecord("Constraint", policyId, 0, constraint);
        transaction.appendEvent("pkr.policy.registered", "Constraint", policyId, 1, {
          version: content.version,
          contentDigest,
        });
        return transaction.committed(constraint);
      },
    );
  }

  policyStatus(policyId: string): JsonObject {
    const policy = this.readPolicyVersion(policyId);
    const relations = policy.record.data.relations as JsonObject[];
    const extension = (policy.record.data.extensions as JsonObject)["pkr.policy/version"] as JsonObject;
    return {
      policyId,
      revision: policy.record.revision,
      version: policy.version,
      contentDigest: policy.contentDigest,
      phase: policy.phase,
      active: policy.phase === "active",
      supersedes: relations
        .filter((relation) => relation.type === "supersedes")
        .map((relation) => (relation.target as JsonObject).id as string),
      restoredFrom: extension.restoredFrom ?? null,
    };
  }

  async rollbackPolicy(
    currentPolicyId: string,
    targetPolicyId: string,
    actorId = this.ownerId(),
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    if (actorId !== this.ownerId()) {
      throw new PkrError("PKR-EVOLUTION-002", "Policy rollback requires the Project owner");
    }
    const current = this.readPolicyVersion(currentPolicyId);
    const target = this.readPolicyVersion(targetPolicyId);
    const directlySupersedes = (current.record.data.relations as JsonObject[]).some((relation) =>
      relation.type === "supersedes" &&
      (relation.target as JsonObject).kind === "Constraint" &&
      (relation.target as JsonObject).id === targetPolicyId,
    );
    const activePolicies = this.listRecords("Constraint").filter((record) => {
      const extension = (record.data.extensions as JsonObject)["pkr.policy/version"] as JsonObject | undefined;
      return extension?.state === "active";
    });
    if (
      current.phase !== "active" ||
      target.phase !== "retired" ||
      !directlySupersedes ||
      activePolicies.length !== 1 ||
      activePolicies[0]!.id !== currentPolicyId
    ) {
      throw new PkrError(
        "PKR-EVOLUTION-011",
        "Policy rollback requires the sole active policy and its directly superseded prior version",
      );
    }

    const restoredPolicyId = derivedId("constraint", `${commandId}:policy`);
    const retired = revisePom(current.record.data, current.record.revision + 1, {
      phase: "retired",
      reason: "PolicyRolledBack",
    });
    retired.extensions = {
      ...(retired.extensions as JsonObject),
      "pkr.policy/version": {
        ...((retired.extensions as JsonObject)["pkr.policy/version"] as JsonObject),
        state: "retired",
      },
    };
    const restored = constraintObject({
      id: restoredPolicyId,
      projectId: this.projectId,
      title: target.policy.title,
      rule: target.policy.rule,
      scopeKinds: target.policy.scopeKinds,
      severity: target.policy.severity,
      enforcement: target.policy.enforcement,
      createdBy: actorId,
      relations: [
        {
          type: "supersedes",
          target: { kind: "Constraint", id: currentPolicyId },
          required: true,
        },
        {
          type: "derivedFrom",
          target: { kind: "Constraint", id: targetPolicyId },
          required: true,
        },
      ],
    });
    restored.extensions = {
      "pkr.policy/version": {
        version: target.version,
        contentDigest: target.contentDigest,
        state: "active",
        content: target.policy as unknown as JsonObject,
        restoredFrom: targetPolicyId,
        rollbackFrom: currentPolicyId,
      },
    };
    this.contracts.validateObject(retired);
    this.contracts.validateObject(restored);
    return this.mutate(
      commandId,
      {
        action: "rollbackPolicy",
        currentPolicyId,
        targetPolicyId,
        restoredPolicyId,
        contentDigest: target.contentDigest,
      },
      (transaction) => {
        transaction.putRecord("Constraint", currentPolicyId, current.record.revision, retired);
        transaction.appendEvent(
          "pkr.policy.retired",
          "Constraint",
          currentPolicyId,
          current.record.revision + 1,
          { reason: "Rollback", restoredAs: restoredPolicyId, source: targetPolicyId },
        );
        transaction.putRecord("Constraint", restoredPolicyId, 0, restored);
        transaction.appendEvent("pkr.policy.rolledBack", "Constraint", restoredPolicyId, 1, {
          from: currentPolicyId,
          source: targetPolicyId,
          contentDigest: target.contentDigest,
        });
        return transaction.committed({
          policyId: restoredPolicyId,
          replaced: currentPolicyId,
          sourcePolicyId: targetPolicyId,
          contentDigest: target.contentDigest,
        });
      },
    );
  }

  async registerAdapter(
    adapter: ManagedAdapterContent,
    actorId = this.ownerId(),
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    if (actorId !== this.ownerId()) {
      throw new PkrError("PKR-EVOLUTION-002", "Adapter registration requires the Project owner");
    }
    const content = JSON.parse(JSON.stringify(adapter)) as unknown as ManagedAdapterContent;
    validateManagedAdapter(content);
    const existing = this.listRecords("Artifact").filter((record) => {
      const extension = (record.data.extensions as JsonObject)["pkr.adapter/version"] as JsonObject | undefined;
      return extension?.adapterId === content.adapterId && extension.state === "active";
    });
    if (existing.length !== 0) {
      throw new PkrError(
        "PKR-EVOLUTION-012",
        `Adapter ${content.adapterId} already has an active managed version`,
        "conflict",
      );
    }
    const adapterVersionId = derivedId("adapter", `${commandId}:adapter`);
    const contentDigest = digest(content);
    const artifact = adapterVersionObject({
      id: adapterVersionId,
      projectId: this.projectId,
      title: content.title,
      contentDigest,
      implementationDigest: content.implementationDigest,
      createdBy: actorId,
      commandId,
    });
    artifact.extensions = {
      "pkr.adapter/version": {
        adapterId: content.adapterId,
        version: content.version,
        contentDigest,
        state: "active",
        content: content as unknown as JsonObject,
      },
    };
    this.contracts.validateObject(artifact);
    return this.mutate(
      commandId,
      {
        action: "registerAdapter",
        adapterVersionId,
        contentDigest,
        adapter: content as unknown as JsonObject,
      },
      (transaction) => {
        transaction.putRecord("Artifact", adapterVersionId, 0, artifact);
        transaction.appendEvent("pkr.adapter.registered", "Artifact", adapterVersionId, 1, {
          adapterId: content.adapterId,
          version: content.version,
          contentDigest,
        });
        return transaction.committed(artifact);
      },
    );
  }

  adapterStatus(adapterVersionId: string): JsonObject {
    const adapter = this.readAdapterVersion(adapterVersionId);
    const relations = adapter.record.data.relations as JsonObject[];
    const extension = (adapter.record.data.extensions as JsonObject)["pkr.adapter/version"] as JsonObject;
    return {
      adapterVersionId,
      adapterId: adapter.adapter.adapterId,
      revision: adapter.record.revision,
      version: adapter.adapter.version,
      contentDigest: adapter.contentDigest,
      phase: adapter.phase,
      active: adapter.phase === "active",
      capabilities: adapter.adapter.capabilities,
      supersedes: relations
        .filter((relation) => relation.type === "supersedes")
        .map((relation) => (relation.target as JsonObject).id as string),
      restoredFrom: extension.restoredFrom ?? null,
    };
  }

  async rollbackAdapter(
    currentAdapterVersionId: string,
    targetAdapterVersionId: string,
    actorId = this.ownerId(),
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    if (actorId !== this.ownerId()) {
      throw new PkrError("PKR-EVOLUTION-002", "Adapter rollback requires the Project owner");
    }
    const current = this.readAdapterVersion(currentAdapterVersionId);
    const target = this.readAdapterVersion(targetAdapterVersionId);
    const directlySupersedes = (current.record.data.relations as JsonObject[]).some((relation) =>
      relation.type === "supersedes" &&
      (relation.target as JsonObject).kind === "Artifact" &&
      (relation.target as JsonObject).id === targetAdapterVersionId,
    );
    const active = this.listRecords("Artifact").filter((record) => {
      const extension = (record.data.extensions as JsonObject)["pkr.adapter/version"] as JsonObject | undefined;
      return extension?.adapterId === current.adapter.adapterId && extension.state === "active";
    });
    if (
      current.adapter.adapterId !== target.adapter.adapterId ||
      current.phase !== "active" ||
      target.phase !== "retired" ||
      !directlySupersedes ||
      active.length !== 1 ||
      active[0]!.id !== currentAdapterVersionId
    ) {
      throw new PkrError(
        "PKR-EVOLUTION-014",
        "Adapter rollback requires the sole active version and its directly superseded predecessor",
      );
    }

    const restoredAdapterVersionId = derivedId("adapter", `${commandId}:adapter`);
    const retired = revisePom(current.record.data, current.record.revision + 1, {
      phase: "archived",
      reason: "AdapterRolledBack",
    });
    retired.extensions = {
      ...(retired.extensions as JsonObject),
      "pkr.adapter/version": {
        ...((retired.extensions as JsonObject)["pkr.adapter/version"] as JsonObject),
        state: "retired",
      },
    };
    const restored = adapterVersionObject({
      id: restoredAdapterVersionId,
      projectId: this.projectId,
      title: target.adapter.title,
      contentDigest: target.contentDigest,
      implementationDigest: target.adapter.implementationDigest,
      createdBy: actorId,
      commandId,
      relations: [
        {
          type: "supersedes",
          target: { kind: "Artifact", id: currentAdapterVersionId },
          required: true,
        },
        {
          type: "derivedFrom",
          target: { kind: "Artifact", id: targetAdapterVersionId },
          required: true,
        },
      ],
    });
    restored.extensions = {
      "pkr.adapter/version": {
        adapterId: target.adapter.adapterId,
        version: target.adapter.version,
        contentDigest: target.contentDigest,
        state: "active",
        content: target.adapter as unknown as JsonObject,
        restoredFrom: targetAdapterVersionId,
        rollbackFrom: currentAdapterVersionId,
      },
    };
    this.contracts.validateObject(retired);
    this.contracts.validateObject(restored);
    return this.mutate(
      commandId,
      {
        action: "rollbackAdapter",
        currentAdapterVersionId,
        targetAdapterVersionId,
        restoredAdapterVersionId,
        contentDigest: target.contentDigest,
      },
      (transaction) => {
        transaction.putRecord("Artifact", currentAdapterVersionId, current.record.revision, retired);
        transaction.appendEvent(
          "pkr.adapter.retired",
          "Artifact",
          currentAdapterVersionId,
          current.record.revision + 1,
          { reason: "Rollback", restoredAs: restoredAdapterVersionId, source: targetAdapterVersionId },
        );
        transaction.putRecord("Artifact", restoredAdapterVersionId, 0, restored);
        transaction.appendEvent("pkr.adapter.rolledBack", "Artifact", restoredAdapterVersionId, 1, {
          from: currentAdapterVersionId,
          source: targetAdapterVersionId,
          contentDigest: target.contentDigest,
        });
        return transaction.committed({
          adapterVersionId: restoredAdapterVersionId,
          replaced: currentAdapterVersionId,
          sourceAdapterVersionId: targetAdapterVersionId,
          contentDigest: target.contentDigest,
        });
      },
    );
  }

  async startPortableWorkflow(
    workflowId: string,
    scope: JsonObject,
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    const workflow = this.getRecord("Workflow", workflowId);
    if ((workflow.data.status as JsonObject).phase !== "active") {
      throw new PkrError("PKR-WORKFLOW-002", "Workflow must be active");
    }
    const extensions = workflow.data.extensions as JsonObject;
    const packageId = extensions["pkr.package/id"] as string | undefined;
    if (packageId) {
      const active = this.listRecords("PackageInstallation").some(
        (record) => record.data.packageId === packageId && record.data.state === "active",
      );
      if (!active) {
        throw new PkrError("PKR-PACKAGE-004", `Package ${packageId} is not active`);
      }
    }
    const rawDefinition = extensions["pkr.workflow/definition"];
    if (rawDefinition === undefined) {
      throw new PkrError("PKR-WORKFLOW-001", "Workflow has no portable definition");
    }
    const definition = parseWorkflowDefinition(rawDefinition);
    const runId = derivedId("run", commandId);
    const timestamp = now();
    const run: JsonObject = {
      apiVersion: "pkr.dev/v0.4",
      kind: "WorkflowRun",
      runId,
      projectId: this.projectId,
      revision: 1,
      projectSequence: this.listEvents().at(-1)?.sequence ?? 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      workflowId,
      workflowRevision: workflow.revision,
      scope,
      state: definition.initial,
      activeSteps: [definition.initial],
      completedSteps: [],
      pendingGates: definition.verificationPolicy,
      extensions: {},
    };
    this.contracts.validateCoordination(run);
    return this.mutate(commandId, { action: "startPortableWorkflow", workflowId, scope }, (transaction) => {
      transaction.putRecord("WorkflowRun", runId, 0, run);
      transaction.appendEvent("pkr.workflowRun.started", "WorkflowRun", runId, 1, {
        state: definition.initial,
      });
      return transaction.committed(run);
    });
  }

  async startClarificationRun(
    runId: string,
    initialState: string,
    clarification: JsonObject,
    workflowDefinition: JsonObject,
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    const manifest = this.getRecord("ProjectManifest", this.projectId).data;
    const ownerId = (manifest.metadata as JsonObject).createdBy as string;
    const definition = parseWorkflowDefinition(workflowDefinition);
    if (definition.initial !== initialState) {
      throw new PkrError("PKR-CLARIFICATION-002", "Clarification run must start at the declared Workflow initial state");
    }
    const workflowId = derivedId("workflow", `${this.projectId}:clarification:v1`);
    const existingWorkflow = this.listRecords("Workflow").find((record) => record.id === workflowId);
    if (existingWorkflow) {
      const existingDefinition = (existingWorkflow.data.extensions as JsonObject)["pkr.workflow/definition"];
      if (
        (existingWorkflow.data.status as JsonObject).phase !== "active" ||
        existingDefinition === undefined ||
        digest(existingDefinition) !== digest(workflowDefinition)
      ) {
        throw new PkrError("PKR-CLARIFICATION-002", "Active clarification Workflow does not match the state machine definition");
      }
    }
    const workflowDraft = existingWorkflow ? undefined : profileWorkflowObject({
      id: workflowId,
      projectId: this.projectId,
      name: "clarification-state-machine",
      title: "PKR Clarification State Machine",
      definition: workflowDefinition,
      appliesTo: ["Goal", "Decision", "Task"],
      createdBy: ownerId,
      revision: 1,
      phase: "draft",
    });
    const workflowActive = existingWorkflow ? undefined : profileWorkflowObject({
      id: workflowId,
      projectId: this.projectId,
      name: "clarification-state-machine",
      title: "PKR Clarification State Machine",
      definition: workflowDefinition,
      appliesTo: ["Goal", "Decision", "Task"],
      createdBy: ownerId,
      revision: 2,
      phase: "active",
    });
    if (workflowDraft && workflowActive) {
      this.contracts.validateObject(workflowDraft);
      this.contracts.validateObject(workflowActive);
    }
    const timestamp = now();
    const run: JsonObject = {
      apiVersion: "pkr.dev/v0.4",
      kind: "WorkflowRun",
      runId,
      projectId: this.projectId,
      revision: 1,
      projectSequence: this.listEvents().at(-1)?.sequence ?? 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      workflowId,
      workflowRevision: existingWorkflow?.revision ?? 2,
      scope: { type: "governance", name: "pkr/clarification" },
      state: initialState,
      activeSteps: [initialState],
      completedSteps: [],
      pendingGates: [],
      extensions: { "pkr.clarification/v1": clarification },
    };
    this.contracts.validateCoordination(run);
    return this.mutate(
      commandId,
      { action: "startClarificationRun", runId, initialState, clarification, workflowDefinitionDigest: digest(workflowDefinition) },
      (transaction) => {
        if (workflowDraft && workflowActive) {
          transaction.putRecord("Workflow", workflowId, 0, workflowDraft);
          transaction.appendEvent("pkr.workflow.created", "Workflow", workflowId, 1);
          transaction.putRecord("Workflow", workflowId, 1, workflowActive);
          transaction.appendEvent("pkr.workflow.phaseChanged", "Workflow", workflowId, 2, { from: "draft", to: "active" });
        }
        const committedRun = {
          ...run,
          projectSequence: transaction.currentSequence() + 1,
        };
        this.contracts.validateCoordination(committedRun);
        transaction.putRecord("WorkflowRun", runId, 0, committedRun);
        transaction.appendEvent("pkr.clarification.started", "WorkflowRun", runId, 1, {
          state: initialState,
        });
        return transaction.committed(committedRun);
      },
    );
  }

  async transitionClarificationRun(
    runId: string,
    to: string,
    clarification: JsonObject,
    terminal: boolean,
    reason: string,
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    const run = this.getRecord("WorkflowRun", runId);
    const existingClarification = (run.data.extensions as JsonObject | undefined)?.["pkr.clarification/v1"];
    if (!existingClarification || typeof existingClarification !== "object" || Array.isArray(existingClarification)) {
      throw new PkrError("PKR-CLARIFICATION-002", `${runId} is not a clarification state machine`);
    }
    const from = run.data.state as string;
    const workflow = this.getRecord("Workflow", run.data.workflowId as string);
    const rawDefinition = (workflow.data.extensions as JsonObject)["pkr.workflow/definition"];
    if (
      workflow.revision !== run.data.workflowRevision ||
      (workflow.data.status as JsonObject).phase !== "active" ||
      rawDefinition === undefined
    ) {
      throw new PkrError("PKR-CLARIFICATION-002", "Clarification run is not bound to its active Workflow revision");
    }
    const definition = parseWorkflowDefinition(rawDefinition);
    const edge = definition.transitions.find((candidate) => candidate.from === from && candidate.to === to);
    if (!edge || !evaluateExpression(edge.when, { authorized: true })) {
      throw new PkrError("PKR-CLARIFICATION-003", `Illegal clarification transition ${from} -> ${to}`);
    }
    const completed = [...new Set([...(run.data.completedSteps as string[]), from])];
    const changed = reviseControl(
      run.data,
      run.revision + 1,
      this.listEvents().length + 1,
      {
        state: to,
        activeSteps: terminal ? [] : [to],
        completedSteps: completed,
        pendingGates: [],
        extensions: { "pkr.clarification/v1": clarification },
      },
    );
    this.contracts.validateCoordination(changed);
    return this.mutate(
      commandId,
      { action: "transitionClarificationRun", runId, from, to, reason, clarification },
      (transaction) => {
        const committed = reviseControl(
          run.data,
          run.revision + 1,
          transaction.currentSequence() + 1,
          {
            state: to,
            activeSteps: terminal ? [] : [to],
            completedSteps: completed,
            pendingGates: [],
            extensions: { "pkr.clarification/v1": clarification },
          },
        );
        this.contracts.validateCoordination(committed);
        transaction.putRecord("WorkflowRun", runId, run.revision, committed);
        transaction.appendEvent(
          "pkr.clarification.transitioned",
          "WorkflowRun",
          runId,
          run.revision + 1,
          { from, to, reason },
        );
        return transaction.committed(committed);
      },
    );
  }

  async transitionPortableWorkflow(
    runId: string,
    to: string,
    context: JsonObject,
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    const run = this.getRecord("WorkflowRun", runId);
    const workflow = this.getRecord("Workflow", run.data.workflowId as string);
    if (workflow.revision !== run.data.workflowRevision) {
      throw new PkrError("PKR-WORKFLOW-002", "WorkflowRun is bound to a superseded Workflow revision");
    }
    const rawDefinition = (workflow.data.extensions as JsonObject)["pkr.workflow/definition"];
    if (rawDefinition === undefined) {
      throw new PkrError("PKR-WORKFLOW-001", "Workflow has no portable definition");
    }
    const definition = parseWorkflowDefinition(rawDefinition);
    const from = run.data.state as string;
    const transition = definition.transitions.find((edge) => edge.from === from && edge.to === to);
    if (!transition || !evaluateExpression(transition.when, context)) {
      throw new PkrError("PKR-WORKFLOW-002", `transition ${from} -> ${to} is not authorized`);
    }
    return this.mutate(
      commandId,
      { action: "transitionPortableWorkflow", runId, from, to, context },
      (transaction) => {
        const completed = [...new Set([...(run.data.completedSteps as string[]), from])];
        const changed = reviseControl(
          run.data,
          run.revision + 1,
          transaction.currentSequence() + 1,
          {
            state: to,
            activeSteps: definition.terminal.includes(to) ? [] : [to],
            completedSteps: completed,
            pendingGates: definition.terminal.includes(to)
              ? []
              : (run.data.pendingGates as JsonValue[]),
          },
        );
        this.contracts.validateCoordination(changed);
        transaction.putRecord("WorkflowRun", runId, run.revision, changed);
        transaction.appendEvent(
          "pkr.workflowRun.transitioned",
          "WorkflowRun",
          runId,
          run.revision + 1,
          { from, to, transition: transition.name },
        );
        return transaction.committed(changed);
      },
    );
  }

  async installProfilePackage(
    profile: ProfilePackage,
    decisionId: string,
    approvedCapabilities: string[],
    actorId = this.ownerId(),
    commandId = newId("command"),
    failStaging = false,
    evolutionBinding?: JsonObject,
  ): Promise<CommandResult<JsonObject>> {
    if (actorId !== this.ownerId()) {
      throw new PkrError("PKR-PACKAGE-002", "Package installation requires the Project owner");
    }
    const decision = this.getRecord("Decision", decisionId);
    if ((decision.data.status as JsonObject).phase !== "accepted") {
      throw new PkrError("PKR-PACKAGE-002", "Package installation requires an accepted Decision");
    }
    const definition = parseWorkflowDefinition(profile.workflow as unknown as JsonValue);
    const requested = new Set(profile.requestedCapabilities);
    if (
      profile.requestedCapabilities.some((capability) => !PACKAGE_CAPABILITY_CEILING.has(capability)) ||
      profile.requestedCapabilities.some((capability) => !approvedCapabilities.includes(capability)) ||
      approvedCapabilities.some((capability) => !requested.has(capability))
    ) {
      throw new PkrError("PKR-PACKAGE-003", "approved capabilities must exactly match declared capabilities within the kernel ceiling");
    }
    const activeInstallations = this.listRecords("PackageInstallation").filter(
      (record) => record.data.state === "active",
    );
    const resolvedDependencies = profile.dependencies.flatMap((dependency) => {
      const installed = activeInstallations.find(
        (record) =>
          record.data.packageId === dependency.packageId &&
          versionSatisfies(record.data.version as string, dependency.versionRange),
      );
      if (!installed && !dependency.optional) {
        throw new PkrError(
          "PKR-PACKAGE-001",
          `missing dependency ${dependency.packageId}@${dependency.versionRange}`,
        );
      }
      return installed
        ? [{ packageId: dependency.packageId, version: installed.data.version, digest: installed.data.digest }]
        : [];
    });
    const previous = activeInstallations.find((record) => record.data.packageId === profile.packageId);
    if (previous?.data.version === profile.version) {
      throw new PkrError("PKR-PACKAGE-001", `${profile.packageId}@${profile.version} is already active`, "conflict");
    }

    const manifestId = derivedId("manifest", `${commandId}:manifest`);
    const installationId = derivedId("installation", `${commandId}:installation`);
    const workflowId = derivedId("workflow", `${profile.packageId}:${profile.version}`);
    const packageDigest = digest(profile);
    const timestamp = now();
    const manifest: JsonObject = {
      apiVersion: "pkr.dev/v0.4",
      kind: "PackageManifest",
      manifestId,
      packageId: profile.packageId,
      version: profile.version,
      digest: packageDigest,
      publisher: { principalId: actorId, name: "PKR" },
      compatibility: { pkrApi: ">=0.4 <1.0", schema: "pkr.dev/v0.4" },
      dependencies: profile.dependencies as unknown as JsonValue,
      conflicts: [],
      contributions: [{
        type: "workflow",
        id: workflowId,
        schemaId: `https://pkr.dev/packages/${profile.packageId}/${profile.version}/workflow.schema.json`,
      }],
      requestedCapabilities: profile.requestedCapabilities,
      lifecycle: {
        install: "atomic-stage",
        migrate: previous ? "deterministic" : "none",
        uninstall: "preserve-history",
        rollback: "previous",
      },
      license: "Apache-2.0",
      distribution: `https://pkr.dev/packages/${profile.packageId}/${profile.version}`,
      extensions: {},
    };
    const staged: JsonObject = {
      apiVersion: "pkr.dev/v0.4",
      kind: "PackageInstallation",
      installationId,
      projectId: this.projectId,
      revision: 1,
      projectSequence: this.listEvents().at(-1)?.sequence ?? 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      packageId: profile.packageId,
      version: profile.version,
      digest: packageDigest,
      resolvedDependencies: resolvedDependencies as unknown as JsonValue,
      approvedCapabilities,
      contributionIds: [workflowId],
      state: "staged",
      installedBy: actorId,
      decisionId,
      workflowId,
      workflowRevision: 2,
      migrationStatus: previous ? "pending" : "notRequired",
      healthStatus: "unknown",
      rollbackTarget: previous?.id ?? null,
      extensions: evolutionBinding
        ? { "pkr.evolution/candidate": evolutionBinding }
        : {},
    };
    const active: JsonObject = {
      ...staged,
      revision: 2,
      updatedAt: timestamp,
      state: "active",
      migrationStatus: previous ? "passed" : "notRequired",
      healthStatus: "healthy",
    };
    const workflowDraft = profileWorkflowObject({
      id: workflowId,
      projectId: this.projectId,
      name: slug(`${profile.packageId}-${profile.version}`),
      title: profile.title,
      definition: definition as unknown as JsonObject,
      createdBy: actorId,
      revision: 1,
      phase: "draft",
    });
    const workflowActive = profileWorkflowObject({
      id: workflowId,
      projectId: this.projectId,
      name: slug(`${profile.packageId}-${profile.version}`),
      title: profile.title,
      definition: definition as unknown as JsonObject,
      createdBy: actorId,
      revision: 2,
      phase: "active",
    });
    for (const workflow of [workflowDraft, workflowActive]) {
      workflow.extensions = {
        ...(workflow.extensions as JsonObject),
        "pkr.package/id": profile.packageId,
        "pkr.package/version": profile.version,
      };
    }
    this.contracts.validateCoordination(manifest);
    this.contracts.validateCoordination(staged);
    this.contracts.validateCoordination(active);
    this.contracts.validateObject(workflowDraft);
    this.contracts.validateObject(workflowActive);

    return this.mutate(
      commandId,
      {
        action: "installProfilePackage",
        packageId: profile.packageId,
        version: profile.version,
        decisionId,
        approvedCapabilities,
        failStaging,
        ...(evolutionBinding ? { evolutionBinding } : {}),
      },
      (transaction) => {
        transaction.putRecord("PackageManifest", manifestId, 0, manifest);
        transaction.appendEvent("pkr.package.manifestRegistered", "PackageManifest", manifestId, 1);
        transaction.putRecord("PackageInstallation", installationId, 0, staged);
        transaction.appendEvent("pkr.package.staged", "PackageInstallation", installationId, 1);
        transaction.putRecord("Workflow", workflowId, 0, workflowDraft);
        transaction.appendEvent("pkr.workflow.created", "Workflow", workflowId, 1);
        if (failStaging) {
          throw new PkrError("PKR-PACKAGE-004", "staged Package health check failed");
        }
        transaction.putRecord("Workflow", workflowId, 1, workflowActive);
        transaction.appendEvent("pkr.workflow.phaseChanged", "Workflow", workflowId, 2, { from: "draft", to: "active" });
        transaction.putRecord("PackageInstallation", installationId, 1, active);
        transaction.appendEvent(
          "pkr.package.activated",
          "PackageInstallation",
          installationId,
          2,
          evolutionBinding ? { candidateId: evolutionBinding.candidateId as string } : {},
        );
        if (previous) {
          const superseded = reviseControl(
            previous.data,
            previous.revision + 1,
            transaction.currentSequence() + 1,
            { state: "superseded", rollbackTarget: installationId },
          );
          this.contracts.validateCoordination(superseded);
          transaction.putRecord("PackageInstallation", previous.id, previous.revision, superseded);
          transaction.appendEvent("pkr.package.superseded", "PackageInstallation", previous.id, previous.revision + 1, {
            replacement: installationId,
          });
        }
        return transaction.committed({
          installationId,
          packageId: profile.packageId,
          version: profile.version,
          workflowId,
          previousInstallationId: previous?.id ?? null,
        });
      },
    );
  }

  async uninstallPackage(
    packageId: string,
    actorId = this.ownerId(),
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    if (actorId !== this.ownerId()) {
      throw new PkrError("PKR-PACKAGE-002", "Package uninstall requires the Project owner");
    }
    const installation = this.listRecords("PackageInstallation").find(
      (record) => record.data.packageId === packageId && record.data.state === "active",
    );
    if (!installation) {
      throw new PkrError("PKR-PACKAGE-004", `active Package ${packageId} was not found`);
    }
    return this.mutate(commandId, { action: "uninstallPackage", packageId }, (transaction) => {
      const uninstalled = reviseControl(
        installation.data,
        installation.revision + 1,
        transaction.currentSequence() + 1,
        { state: "uninstalled", healthStatus: "unknown" },
      );
      this.contracts.validateCoordination(uninstalled);
      transaction.putRecord("PackageInstallation", installation.id, installation.revision, uninstalled);
      transaction.appendEvent("pkr.package.uninstalled", "PackageInstallation", installation.id, installation.revision + 1);
      return transaction.committed({ installationId: installation.id, packageId });
    });
  }

  async rollbackPackage(
    packageId: string,
    targetInstallationId: string,
    actorId = this.ownerId(),
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    if (actorId !== this.ownerId()) {
      throw new PkrError("PKR-PACKAGE-002", "Package rollback requires the Project owner");
    }
    const current = this.listRecords("PackageInstallation").find(
      (record) => record.data.packageId === packageId && record.data.state === "active",
    );
    const target = this.getRecord("PackageInstallation", targetInstallationId);
    if (!current || target.data.packageId !== packageId || target.id === current.id) {
      throw new PkrError("PKR-PACKAGE-004", "rollback requires a prior installation of the same Package");
    }
    return this.mutate(
      commandId,
      { action: "rollbackPackage", packageId, current: current.id, target: target.id },
      (transaction) => {
        const superseded = reviseControl(
          current.data,
          current.revision + 1,
          transaction.currentSequence() + 1,
          { state: "superseded", rollbackTarget: target.id },
        );
        const restored = reviseControl(
          target.data,
          target.revision + 1,
          transaction.currentSequence() + 2,
          { state: "active", healthStatus: "healthy", rollbackTarget: current.id },
        );
        this.contracts.validateCoordination(superseded);
        this.contracts.validateCoordination(restored);
        transaction.putRecord("PackageInstallation", current.id, current.revision, superseded);
        transaction.appendEvent("pkr.package.superseded", "PackageInstallation", current.id, current.revision + 1, {
          rollbackTarget: target.id,
        });
        transaction.putRecord("PackageInstallation", target.id, target.revision, restored);
        transaction.appendEvent("pkr.package.rolledBack", "PackageInstallation", target.id, target.revision + 1, {
          from: current.id,
        });
        return transaction.committed({ packageId, installationId: target.id, replaced: current.id });
      },
    );
  }

  async proposeEvolutionFromFailures(
    candidate: EvolutionCandidateSpec,
    proposerId: string,
    threshold = 2,
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    return this.proposeEvolutionFromObservation(
      candidate,
      { rule: "repeated-failure", threshold },
      proposerId,
      commandId,
    );
  }

  async recordMetric(
    measure: string,
    sourceAdapter: string,
    window: string,
    threshold: MetricThreshold,
    value: string | number | boolean,
    actorId = this.ownerId(),
    commandId = newId("command"),
    sourceConfiguration: JsonObject = {},
  ): Promise<CommandResult<JsonObject>> {
    if (
      !measure.trim() ||
      !sourceAdapter.trim() ||
      !window.trim() ||
      !["eq", "neq", "gt", "gte", "lt", "lte"].includes(threshold.operator) ||
      !["info", "warning", "error", "critical"].includes(threshold.severity) ||
      (typeof value === "number" && !Number.isFinite(value)) ||
      (typeof threshold.value === "number" && !Number.isFinite(threshold.value))
    ) {
      throw new PkrError(
        "PKR-METRIC-001",
        "Metric measure, source adapter, and window are required",
      );
    }
    const thresholdSatisfied = metricThresholdSatisfied(value, threshold);
    const metricId = derivedId("metric", commandId);
    const metric = metricObject({
      id: metricId,
      projectId: this.projectId,
      measure: measure.trim(),
      sourceAdapter,
      sourceConfiguration,
      window,
      threshold,
      value,
      thresholdSatisfied,
      createdBy: actorId,
    });
    this.contracts.validateObject(metric);
    return this.mutate(
      commandId,
      {
        action: "recordMetric",
        metricId,
        measure: measure.trim(),
        sourceAdapter,
        sourceConfiguration,
        window,
        threshold: threshold as unknown as JsonObject,
        value,
      },
      (transaction) => {
        transaction.putRecord("Metric", metricId, 0, metric);
        transaction.appendEvent("pkr.metric.observed", "Metric", metricId, 1, {
          value,
          thresholdSatisfied,
          phase: thresholdSatisfied ? "healthy" : "breached",
        });
        return transaction.committed(metric);
      },
    );
  }

  async proposeEvolutionFromObservation(
    candidate: EvolutionCandidateSpec,
    observation: EvolutionObservationSpec,
    proposerId: string,
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    validateEvolutionCandidate(candidate);
    validateEvolutionObservation(observation);
    if (candidate.targetKind === "workflow") {
      const active = this.listRecords("PackageInstallation").find(
        (record) => record.data.packageId === candidate.targetId && record.data.state === "active",
      );
      if (!active || active.data.version !== candidate.activeVersion) {
        throw new PkrError(
          "PKR-EVOLUTION-001",
          "candidate does not bind the current active Package version",
          "conflict",
        );
      }
    } else if (candidate.targetKind === "prompt") {
      const active = this.readPromptVersion(candidate.targetId);
      if (active.phase !== "active" || active.contentDigest !== candidate.activeVersion) {
        throw new PkrError(
          "PKR-EVOLUTION-004",
          "Prompt candidate does not bind the current active content digest",
          "conflict",
        );
      }
      if (
        digest(candidate.prompt!.template) === active.contentDigest ||
        candidate.prompt!.version === active.version
      ) {
        throw new PkrError(
          "PKR-EVOLUTION-008",
          "Prompt candidate must declare new content and a new version",
          "conflict",
        );
      }
    } else if (candidate.targetKind === "policy") {
      const active = this.readPolicyVersion(candidate.targetId);
      const activePolicies = this.listRecords("Constraint").filter((record) => {
        const extension = (record.data.extensions as JsonObject)["pkr.policy/version"] as JsonObject | undefined;
        return extension?.state === "active";
      });
      if (
        active.phase !== "active" ||
        active.contentDigest !== candidate.activeVersion ||
        activePolicies.length !== 1 ||
        activePolicies[0]!.id !== candidate.targetId
      ) {
        throw new PkrError(
          "PKR-EVOLUTION-004",
          "Policy candidate does not bind the sole active content digest",
          "conflict",
        );
      }
      if (
        digest(candidate.policy!) === active.contentDigest ||
        candidate.policy!.version === active.version
      ) {
        throw new PkrError(
          "PKR-EVOLUTION-010",
          "Policy candidate must declare new content and a new version",
          "conflict",
        );
      }
    } else if (candidate.targetKind === "adapter") {
      const active = this.readAdapterVersion(candidate.targetId);
      const activeVersions = this.listRecords("Artifact").filter((record) => {
        const extension = (record.data.extensions as JsonObject)["pkr.adapter/version"] as JsonObject | undefined;
        return extension?.adapterId === active.adapter.adapterId && extension.state === "active";
      });
      if (
        active.phase !== "active" ||
        active.contentDigest !== candidate.activeVersion ||
        activeVersions.length !== 1 ||
        activeVersions[0]!.id !== candidate.targetId
      ) {
        throw new PkrError(
          "PKR-EVOLUTION-004",
          "Adapter candidate does not bind the sole active content digest",
          "conflict",
        );
      }
      const proposed = candidate.adapter!;
      const activeCapabilities = new Set(active.adapter.capabilities);
      const proposedCapabilities = new Set(proposed.capabilities);
      const added = proposed.capabilities.filter((capability) => !activeCapabilities.has(capability));
      const removed = active.adapter.capabilities.filter(
        (capability) => !proposedCapabilities.has(capability),
      );
      if (
        proposed.adapterId !== active.adapter.adapterId ||
        added.length !== 0 ||
        JSON.stringify([...candidate.permissionDelta.remove].sort()) !==
          JSON.stringify([...removed].sort())
      ) {
        throw new PkrError(
          "PKR-EVOLUTION-012",
          "Adapter candidate cannot change identity, add capabilities, or misstate its permission delta",
        );
      }
      if (
        digest(proposed) === active.contentDigest ||
        proposed.version === active.adapter.version
      ) {
        throw new PkrError(
          "PKR-EVOLUTION-012",
          "Adapter candidate must declare new content and a new version",
          "conflict",
        );
      }
    }

    let observations: JsonValue[];
    let summary: string;
    let impact: string;
    let issueType: "risk" | "feedback" = "risk";
    let severity: "info" | "warning" | "error" | "critical" = "warning";
    let issueReason: string;
    if (observation.rule === "repeated-failure") {
      const threshold = observation.threshold ?? 2;
      const failures = this.listRecords("Assignment").filter((record) =>
        ["blocked", "expired", "failed"].includes(record.data.state as string),
      );
      if (failures.length < threshold) {
        throw new PkrError(
          "PKR-EVOLUTION-007",
          `repeated-failure rule requires ${threshold} observations, found ${failures.length}`,
        );
      }
      observations = failures.map((record) => ({
        kind: record.kind,
        id: record.id,
        revision: record.revision,
        state: record.data.state as string,
        digest: digest(record.data),
      }));
      summary = `${failures.length} governed execution failures exceeded threshold ${threshold}.`;
      impact = "Repeated execution failure increases delivery delay and requires a bounded inactive improvement proposal.";
      issueReason = "RepeatedFailures";
    } else if (observation.rule === "assurance-debt") {
      const threshold = observation.threshold ?? 1;
      const verifications = observation.verificationRefs
        ? observation.verificationRefs.map((reference) => {
            const record = this.getRecord("Verification", reference.id);
            if (record.revision !== reference.revision) {
              throw new PkrError(
                "PKR-EVOLUTION-007",
                `Verification/${reference.id} revision ${reference.revision} is stale`,
                "conflict",
              );
            }
            return record;
          })
        : this.listRecords("Verification");
      const debt = verifications.filter((record) =>
        ["failed", "waived"].includes((record.data.status as JsonObject).phase as string),
      );
      if (observation.verificationRefs && debt.length !== verifications.length) {
        throw new PkrError(
          "PKR-EVOLUTION-007",
          "every explicit assurance-debt reference must be failed or waived",
        );
      }
      if (debt.length < threshold) {
        throw new PkrError(
          "PKR-EVOLUTION-007",
          `assurance-debt rule requires ${threshold} observations, found ${debt.length}`,
        );
      }
      observations = debt.map((record) => ({
        kind: record.kind,
        id: record.id,
        revision: record.revision,
        state: (record.data.status as JsonObject).phase as string,
        gate: (record.data.spec as JsonObject).gate as string,
        digest: digest(record.data),
      }));
      summary = `${debt.length} failed or waived Verification records exceeded assurance-debt threshold ${threshold}.`;
      impact = "Unresolved assurance debt weakens completion confidence and requires a bounded verified improvement.";
      issueReason = "AssuranceDebtObserved";
    } else if (observation.rule === "metric-threshold") {
      const metric = this.getRecord("Metric", observation.metric.id);
      if (metric.revision !== observation.metric.revision) {
        throw new PkrError(
          "PKR-EVOLUTION-007",
          `Metric/${metric.id} revision ${observation.metric.revision} is stale`,
          "conflict",
        );
      }
      const status = metric.data.status as JsonObject;
      if (status.phase !== "breached") {
        throw new PkrError(
          "PKR-EVOLUTION-007",
          `Metric/${metric.id} is ${status.phase as string}, not breached`,
        );
      }
      const metricSpec = metric.data.spec as JsonObject;
      const metricThreshold = (metricSpec.thresholds as JsonObject[])[0]!;
      observations = [{
        kind: metric.kind,
        id: metric.id,
        revision: metric.revision,
        state: status.phase as string,
        value: status.lastValue ?? null,
        threshold: metricThreshold,
        digest: digest(metric.data),
      }];
      summary = `Metric threshold breached: ${metricSpec.measure as string}.`;
      impact = "A measured project outcome is outside its declared threshold and requires a bounded improvement proposal.";
      severity = metricThreshold.severity as "info" | "warning" | "error" | "critical";
      issueReason = "MetricThresholdBreached";
    } else {
      const feedbackContent = {
        submittedBy: observation.submittedBy,
        feedback: observation.feedback.trim(),
        impact: observation.impact.trim(),
      };
      observations = [{
        kind: "HumanFeedback",
        id: derivedId("feedback", `${commandId}:feedback`),
        revision: 1,
        state: "recorded",
        ...feedbackContent,
        digest: digest(feedbackContent),
      }];
      summary = observation.feedback.trim();
      impact = observation.impact.trim();
      issueType = "feedback";
      severity = "info";
      issueReason = "HumanFeedbackRecorded";
    }

    return this.createEvolutionProposal(
      candidate,
      proposerId,
      observation.rule,
      observations,
      summary,
      impact,
      issueType,
      severity,
      issueReason,
      commandId,
    );
  }

  private createEvolutionProposal(
    candidate: EvolutionCandidateSpec,
    proposerId: string,
    observationRule: EvolutionObservationSpec["rule"],
    observations: JsonValue[],
    summary: string,
    impact: string,
    issueType: "risk" | "feedback",
    severity: "info" | "warning" | "error" | "critical",
    issueReason: string,
    commandId: string,
  ): Promise<CommandResult<JsonObject>> {
    const content = JSON.parse(JSON.stringify(candidate)) as JsonObject;
    const contentDigest = digest(content);
    const issueId = derivedId("issue", `${commandId}:issue`);
    const candidateId = derivedId("candidate", `${commandId}:candidate`);
    const issue = issueObject({
      id: issueId,
      projectId: this.projectId,
      summary,
      impact,
      observations,
      createdBy: proposerId,
      issueType,
      severity,
      reason: issueReason,
      observationRule,
    });
    const artifact = evolutionCandidateObject({
      id: candidateId,
      projectId: this.projectId,
      issueId,
      content,
      contentDigest,
      targetKind: candidate.targetKind,
      targetId: candidate.targetId,
      activeVersion: candidate.activeVersion,
      proposerId,
      permissionDelta: candidate.permissionDelta as unknown as JsonObject,
      createdBy: proposerId,
    });
    this.contracts.validateObject(issue);
    this.contracts.validateObject(artifact);
    return this.mutate(
      commandId,
      {
        action: "proposeEvolutionFromObservation",
        candidateId,
        issueId,
        contentDigest,
        observationRule,
        observationDigest: digest(observations),
      },
      (transaction) => {
        transaction.putRecord("Issue", issueId, 0, issue);
        transaction.appendEvent("pkr.issue.opened", "Issue", issueId, 1, {
          observationRule,
          observationCount: observations.length,
        });
        transaction.putRecord("Artifact", candidateId, 0, artifact);
        transaction.appendEvent("pkr.evolution.candidateProposed", "Artifact", candidateId, 1, {
          issueId,
          contentDigest,
          observationRule,
        });
        return transaction.committed({ issueId, candidateId, contentDigest, state: "inactive" });
      },
    );
  }

  async reviseEvolutionCandidate(
    candidateId: string,
    candidate: EvolutionCandidateSpec,
    proposerId: string,
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    validateEvolutionCandidate(candidate);
    const previous = this.readEvolutionCandidate(candidateId);
    this.assertEvolutionCandidateCurrent(candidateId);
    if (previous.proposerId !== proposerId) {
      throw new PkrError("PKR-EVOLUTION-002", "only the originating proposer may revise a candidate");
    }
    if (
      candidate.targetKind !== previous.candidate.targetKind ||
      candidate.targetId !== previous.candidate.targetId ||
      candidate.activeVersion !== previous.candidate.activeVersion
    ) {
      throw new PkrError("PKR-EVOLUTION-003", "candidate revision cannot change its bound target");
    }
    if (candidate.targetKind === "adapter") {
      const active = this.readAdapterVersion(candidate.targetId);
      const activeCapabilities = new Set(active.adapter.capabilities);
      const proposedCapabilities = new Set(candidate.adapter!.capabilities);
      const added = candidate.adapter!.capabilities.filter(
        (capability) => !activeCapabilities.has(capability),
      );
      const removed = active.adapter.capabilities.filter(
        (capability) => !proposedCapabilities.has(capability),
      );
      if (
        active.phase !== "active" ||
        active.contentDigest !== candidate.activeVersion ||
        candidate.adapter!.adapterId !== active.adapter.adapterId ||
        added.length !== 0 ||
        JSON.stringify([...candidate.permissionDelta.remove].sort()) !==
          JSON.stringify([...removed].sort()) ||
        digest(candidate.adapter!) === active.contentDigest ||
        candidate.adapter!.version === active.adapter.version
      ) {
        throw new PkrError(
          "PKR-EVOLUTION-012",
          "revised Adapter candidate must preserve its active identity and exact capability delta",
          "conflict",
        );
      }
    }
    const content = JSON.parse(JSON.stringify(candidate)) as JsonObject;
    const contentDigest = digest(content);
    if (contentDigest === previous.contentDigest) {
      throw new PkrError("PKR-EVOLUTION-003", "candidate revision must change content", "conflict");
    }
    const issueRelation = (previous.record.data.relations as JsonObject[]).find(
      (relation) => relation.type === "derivedFrom" &&
        (relation.target as JsonObject).kind === "Issue",
    );
    if (!issueRelation) {
      throw new PkrError("PKR-EVOLUTION-003", "candidate has no originating Issue");
    }
    const issueId = (issueRelation.target as JsonObject).id as string;
    const revisedId = derivedId("candidate", `${commandId}:candidate`);
    const artifact = evolutionCandidateObject({
      id: revisedId,
      projectId: this.projectId,
      issueId,
      content,
      contentDigest,
      targetKind: candidate.targetKind,
      targetId: candidate.targetId,
      activeVersion: candidate.activeVersion,
      proposerId,
      permissionDelta: candidate.permissionDelta as unknown as JsonObject,
      createdBy: proposerId,
      supersedesId: candidateId,
    });
    this.contracts.validateObject(artifact);
    return this.mutate(
      commandId,
      { action: "reviseEvolutionCandidate", candidateId, revisedId, contentDigest },
      (transaction) => {
        transaction.putRecord("Artifact", revisedId, 0, artifact);
        transaction.appendEvent("pkr.evolution.candidateRevised", "Artifact", revisedId, 1, {
          supersedes: candidateId,
          contentDigest,
        });
        return transaction.committed({
          issueId,
          candidateId: revisedId,
          supersedes: candidateId,
          contentDigest,
          state: "inactive",
        });
      },
    );
  }

  async approveEvolutionCandidate(
    candidateId: string,
    approverId = this.ownerId(),
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    const candidate = this.readEvolutionCandidate(candidateId);
    this.assertEvolutionCandidateCurrent(candidateId);
    if (approverId !== this.ownerId() || approverId === candidate.proposerId) {
      throw new PkrError(
        "PKR-EVOLUTION-002",
        "candidate approval requires the Project owner distinct from the proposer",
      );
    }
    if (this.acceptedEvolutionDecision(candidateId, candidate.contentDigest)) {
      throw new PkrError("PKR-EVOLUTION-004", "candidate already has a digest-bound accepted Decision", "conflict");
    }
    const verifications = this.listRecords("Verification").filter((record) => {
      const binding = (record.data.extensions as JsonObject)["pkr.evolution/candidate"] as JsonObject | undefined;
      return binding?.candidateId === candidateId && binding.candidateDigest === candidate.contentDigest;
    });
    const passing = verifications.find(
      (record) => (record.data.status as JsonObject).phase === "passed",
    );
    const failed = verifications.some(
      (record) => (record.data.status as JsonObject).phase === "failed",
    );
    if (!passing || failed) {
      throw new PkrError(
        "PKR-EVOLUTION-005",
        "candidate approval requires passing digest-bound evaluation evidence with no failed result",
      );
    }
    const verifierId = ((passing.data.status as JsonObject).executor as JsonObject).principalId as string;
    if (approverId === verifierId) {
      throw new PkrError(
        "PKR-EVOLUTION-002",
        "candidate approval requires the Project owner distinct from proposer and verifier",
      );
    }
    const decisionId = derivedId("decision", commandId);
    const affectedKinds = candidate.candidate.targetKind === "workflow"
      ? ["Workflow", "Artifact"]
      : candidate.candidate.targetKind === "prompt"
        ? ["Knowledge", "Artifact"]
        : candidate.candidate.targetKind === "policy"
          ? ["Constraint", "Artifact"]
          : candidate.candidate.targetKind === "adapter"
            ? ["Artifact", "Agent"]
        : ["Artifact", "Release"];
    const proposed = decisionObject({
      id: decisionId,
      projectId: this.projectId,
      question: `Approve candidate ${candidateId} at ${candidate.contentDigest}?`,
      choice: "Approve promotion, monitoring, and declared rollback gates after independent evaluation",
      reason: candidate.candidate.expectedImprovement,
      affectedKinds,
      createdBy: approverId,
    });
    const accepted = decisionObject({
      id: decisionId,
      projectId: this.projectId,
      question: `Approve candidate ${candidateId} at ${candidate.contentDigest}?`,
      choice: "Approve promotion, monitoring, and declared rollback gates after independent evaluation",
      reason: candidate.candidate.expectedImprovement,
      affectedKinds,
      createdBy: approverId,
      revision: 2,
      phase: "accepted",
    });
    for (const decision of [proposed, accepted]) {
      decision.extensions = {
        "pkr.evolution/candidate": {
          candidateId,
          candidateDigest: candidate.contentDigest,
          proposerId: candidate.proposerId,
          verificationId: passing.id,
          verifierId,
          approverId,
        },
      };
      decision.relations = [{
        type: "informedBy",
        target: { kind: "Artifact", id: candidateId },
        required: true,
      }];
    }
    this.contracts.validateObject(proposed);
    this.contracts.validateObject(accepted);
    return this.mutate(
      commandId,
      {
        action: "approveEvolutionCandidate",
        candidateId,
        candidateDigest: candidate.contentDigest,
        verificationId: passing.id,
        verifierId,
        approverId,
      },
      (transaction) => {
        transaction.putRecord("Decision", decisionId, 0, proposed);
        transaction.appendEvent("pkr.decision.proposed", "Decision", decisionId, 1, { candidateId });
        transaction.putRecord("Decision", decisionId, 1, accepted);
        transaction.appendEvent("pkr.decision.accepted", "Decision", decisionId, 2, {
          candidateId,
          candidateDigest: candidate.contentDigest,
        });
        return transaction.committed({
          decisionId,
          candidateId,
          candidateDigest: candidate.contentDigest,
          verificationId: passing.id,
          verifierId,
        });
      },
    );
  }

  async evaluateEvolutionCandidate(
    candidateId: string,
    verifierId: string,
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    const candidate = this.readEvolutionCandidate(candidateId);
    this.assertEvolutionCandidateCurrent(candidateId);
    if (this.acceptedEvolutionDecision(candidateId, candidate.contentDigest)) {
      throw new PkrError(
        "PKR-EVOLUTION-004",
        "candidate evaluation must precede its digest-bound owner Decision",
        "conflict",
      );
    }
    if (verifierId === candidate.proposerId) {
      throw new PkrError("PKR-EVOLUTION-002", "candidate verifier must be distinct from proposer");
    }
    if (candidate.candidate.targetKind === "runtime") {
      throw new PkrError(
        "PKR-EVOLUTION-005",
        "Runtime candidates require an external supervisor evaluation",
      );
    }
    const canary = candidate.candidate.targetKind === "prompt"
      ? evaluatePromptCanary(candidate.candidate)
      : candidate.candidate.targetKind === "policy"
        ? evaluatePolicyCanary(candidate.candidate)
        : candidate.candidate.targetKind === "adapter"
          ? evaluateAdapterCanary(candidate.candidate)
        : evaluateWorkflowCanary(candidate.candidate);
    const evaluationDigest = digest({ candidateDigest: candidate.contentDigest, canary });
    const result: JsonObject = { ...canary, digest: evaluationDigest };
    const evaluationId = derivedId("evaluation", `${commandId}:artifact`);
    const verificationId = derivedId("verification", `${commandId}:verification`);
    const evaluation = evolutionEvaluationArtifactObject({
      id: evaluationId,
      projectId: this.projectId,
      candidateId,
      candidateDigest: candidate.contentDigest,
      result,
      createdBy: verifierId,
    });
    const verification = evolutionVerificationObject({
      id: verificationId,
      projectId: this.projectId,
      candidateId,
      candidateDigest: candidate.contentDigest,
      evaluationId,
      passed: canary.passed as boolean,
      createdBy: verifierId,
      ...(candidate.candidate.targetKind === "prompt"
        ? { methodAdapter: "pkr/prompt-canary", methodVersion: "0.8.0" }
        : candidate.candidate.targetKind === "policy"
          ? { methodAdapter: "pkr/policy-canary", methodVersion: "0.8.0" }
          : candidate.candidate.targetKind === "adapter"
            ? { methodAdapter: "pkr/adapter-conformance", methodVersion: "0.8.0" }
          : {}),
    });
    this.contracts.validateObject(evaluation);
    this.contracts.validateObject(verification);
    return this.mutate(
      commandId,
      { action: "evaluateEvolutionCandidate", candidateId, candidateDigest: candidate.contentDigest, verifierId },
      (transaction) => {
        transaction.putRecord("Artifact", evaluationId, 0, evaluation);
        transaction.appendEvent("pkr.evolution.canaryRecorded", "Artifact", evaluationId, 1, {
          candidateId,
          passed: canary.passed as boolean,
        });
        transaction.putRecord("Verification", verificationId, 0, verification);
        transaction.appendEvent(
          canary.passed ? "pkr.verification.passed" : "pkr.verification.failed",
          "Verification",
          verificationId,
          1,
          { candidateId, candidateDigest: candidate.contentDigest },
        );
        return transaction.committed({
          candidateId,
          candidateDigest: candidate.contentDigest,
          evaluationId,
          verificationId,
          passed: canary.passed as boolean,
          result,
        });
      },
    );
  }

  async recordExternalEvolutionEvaluation(
    candidateId: string,
    supervisorId: string,
    supervisorResult: JsonObject,
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    const candidate = this.readEvolutionCandidate(candidateId);
    this.assertEvolutionCandidateCurrent(candidateId);
    if (candidate.candidate.targetKind !== "runtime") {
      throw new PkrError(
        "PKR-EVOLUTION-006",
        "only Runtime candidates may use an external supervisor evaluation",
      );
    }
    if (this.acceptedEvolutionDecision(candidateId, candidate.contentDigest)) {
      throw new PkrError(
        "PKR-EVOLUTION-004",
        "external evaluation must precede the digest-bound owner Decision",
        "conflict",
      );
    }
    if (supervisorId === candidate.proposerId) {
      throw new PkrError(
        "PKR-EVOLUTION-002",
        "external supervisor must be distinct from proposer",
      );
    }
    if (supervisorResult.candidateDigest !== candidate.contentDigest) {
      throw new PkrError(
        "PKR-EVOLUTION-004",
        "external supervisor result is not bound to the current candidate digest",
        "conflict",
      );
    }
    const passed = validateExternalSupervisorResult(
      candidate.candidate,
      supervisorId,
      supervisorResult,
    );
    const evaluationDigest = digest({
      candidateDigest: candidate.contentDigest,
      supervisorResult,
    });
    const result: JsonObject = { ...supervisorResult, digest: evaluationDigest };
    const evaluationId = derivedId("evaluation", `${commandId}:artifact`);
    const verificationId = derivedId("verification", `${commandId}:verification`);
    const evaluation = evolutionEvaluationArtifactObject({
      id: evaluationId,
      projectId: this.projectId,
      candidateId,
      candidateDigest: candidate.contentDigest,
      result,
      createdBy: supervisorId,
    });
    const verification = evolutionVerificationObject({
      id: verificationId,
      projectId: this.projectId,
      candidateId,
      candidateDigest: candidate.contentDigest,
      evaluationId,
      passed,
      createdBy: supervisorId,
      methodAdapter: "pkr/external-supervisor",
      methodVersion: "0.8.0",
    });
    this.contracts.validateObject(evaluation);
    this.contracts.validateObject(verification);
    return this.mutate(
      commandId,
      {
        action: "recordExternalEvolutionEvaluation",
        candidateId,
        candidateDigest: candidate.contentDigest,
        supervisorId,
      },
      (transaction) => {
        transaction.putRecord("Artifact", evaluationId, 0, evaluation);
        transaction.appendEvent(
          "pkr.evolution.externalEvaluationRecorded",
          "Artifact",
          evaluationId,
          1,
          { candidateId, candidateDigest: candidate.contentDigest, supervisorId, passed },
        );
        transaction.putRecord("Verification", verificationId, 0, verification);
        transaction.appendEvent(
          passed ? "pkr.verification.passed" : "pkr.verification.failed",
          "Verification",
          verificationId,
          1,
          { candidateId, candidateDigest: candidate.contentDigest, supervisorId },
        );
        return transaction.committed({
          candidateId,
          candidateDigest: candidate.contentDigest,
          evaluationId,
          verificationId,
          supervisorId,
          passed,
          result,
        });
      },
    );
  }

  async promoteEvolutionCandidate(
    candidateId: string,
    promoterId = this.ownerId(),
    externalSupervisorId?: string,
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    const candidate = this.readEvolutionCandidate(candidateId);
    this.assertEvolutionCandidateCurrent(candidateId);
    if (candidate.candidate.targetKind === "runtime") {
      if (!externalSupervisorId) {
        throw new PkrError(
          "PKR-EVOLUTION-006",
          "Runtime self-update requires an external trusted supervisor",
        );
      }
      throw new PkrError(
        "PKR-EVOLUTION-006",
        `Runtime candidate must be activated out of process by ${externalSupervisorId}`,
      );
    }
    const existingActivation = [
      ...this.listRecords("PackageInstallation"),
      ...this.listRecords("Knowledge"),
      ...this.listRecords("Constraint"),
      ...this.listRecords("Artifact"),
    ].find((record) => {
      const binding = (record.data.extensions as JsonObject)["pkr.evolution/candidate"] as JsonObject | undefined;
      return binding?.candidateId === candidateId && binding.candidateDigest === candidate.contentDigest;
    });
    if (existingActivation) {
      throw new PkrError(
        "PKR-EVOLUTION-004",
        `candidate was already activated as ${existingActivation.kind}/${existingActivation.id}`,
        "conflict",
      );
    }
    if (promoterId !== this.ownerId() || promoterId === candidate.proposerId) {
      throw new PkrError("PKR-EVOLUTION-002", "promotion requires the Project owner distinct from proposer");
    }
    const passing = this.listRecords("Verification").find((record) => {
      const binding = (record.data.extensions as JsonObject)["pkr.evolution/candidate"] as JsonObject | undefined;
      return binding?.candidateId === candidateId &&
        binding.candidateDigest === candidate.contentDigest &&
        (record.data.status as JsonObject).phase === "passed";
    });
    const failed = this.listRecords("Verification").some((record) => {
      const binding = (record.data.extensions as JsonObject)["pkr.evolution/candidate"] as JsonObject | undefined;
      return binding?.candidateId === candidateId &&
        binding.candidateDigest === candidate.contentDigest &&
        (record.data.status as JsonObject).phase === "failed";
    });
    if (!passing || failed) {
      throw new PkrError("PKR-EVOLUTION-005", "candidate has no passing digest-bound canary Verification");
    }
    const decision = this.acceptedEvolutionDecision(candidateId, candidate.contentDigest);
    if (!decision) {
      throw new PkrError("PKR-EVOLUTION-004", "candidate has no digest-bound accepted Decision");
    }
    const verifierId = ((passing.data.status as JsonObject).executor as JsonObject).principalId as string;
    if (promoterId === verifierId) {
      throw new PkrError("PKR-EVOLUTION-002", "promotion principal must be distinct from verifier");
    }
    if (candidate.candidate.targetKind === "adapter") {
      const active = this.readAdapterVersion(candidate.candidate.targetId);
      const activeVersions = this.listRecords("Artifact").filter((record) => {
        const extension = (record.data.extensions as JsonObject)["pkr.adapter/version"] as JsonObject | undefined;
        return extension?.adapterId === active.adapter.adapterId && extension.state === "active";
      });
      const adapterContent = candidate.candidate.adapter!;
      const activeCapabilities = new Set(active.adapter.capabilities);
      const proposedCapabilities = new Set(adapterContent.capabilities);
      const added = adapterContent.capabilities.filter(
        (capability) => !activeCapabilities.has(capability),
      );
      const removed = active.adapter.capabilities.filter(
        (capability) => !proposedCapabilities.has(capability),
      );
      if (
        active.phase !== "active" ||
        active.contentDigest !== candidate.candidate.activeVersion ||
        activeVersions.length !== 1 ||
        activeVersions[0]!.id !== active.record.id ||
        adapterContent.adapterId !== active.adapter.adapterId ||
        added.length !== 0 ||
        JSON.stringify([...candidate.candidate.permissionDelta.remove].sort()) !==
          JSON.stringify([...removed].sort())
      ) {
        throw new PkrError(
          "PKR-EVOLUTION-004",
          "Adapter candidate active-version or capability basis is stale",
          "conflict",
        );
      }
      const adapterVersionId = derivedId("adapter", `${commandId}:adapter`);
      const adapterContentDigest = digest(adapterContent);
      const artifact = adapterVersionObject({
        id: adapterVersionId,
        projectId: this.projectId,
        title: adapterContent.title,
        contentDigest: adapterContentDigest,
        implementationDigest: adapterContent.implementationDigest,
        createdBy: promoterId,
        commandId,
        relations: [{
          type: "supersedes",
          target: { kind: "Artifact", id: active.record.id },
          required: true,
        }],
      });
      artifact.extensions = {
        "pkr.adapter/version": {
          adapterId: adapterContent.adapterId,
          version: adapterContent.version,
          contentDigest: adapterContentDigest,
          state: "active",
          content: adapterContent as unknown as JsonObject,
        },
        "pkr.evolution/candidate": {
          candidateId,
          candidateDigest: candidate.contentDigest,
          decisionId: decision.id,
          verificationId: passing.id,
          proposerId: candidate.proposerId,
          verifierId,
          promoterId,
        },
      };
      const retired = revisePom(active.record.data, active.record.revision + 1, {
        phase: "archived",
        reason: "AdapterSuperseded",
      });
      retired.extensions = {
        ...(retired.extensions as JsonObject),
        "pkr.adapter/version": {
          ...((retired.extensions as JsonObject)["pkr.adapter/version"] as JsonObject),
          state: "retired",
        },
      };
      this.contracts.validateObject(artifact);
      this.contracts.validateObject(retired);
      return this.mutate(
        commandId,
        {
          action: "promoteAdapterCandidate",
          candidateId,
          candidateDigest: candidate.contentDigest,
          adapterVersionId,
          replaced: active.record.id,
          decisionId: decision.id,
          verificationId: passing.id,
        },
        (transaction) => {
          transaction.putRecord("Artifact", active.record.id, active.record.revision, retired);
          transaction.appendEvent(
            "pkr.adapter.retired",
            "Artifact",
            active.record.id,
            active.record.revision + 1,
            { supersededBy: adapterVersionId, candidateId },
          );
          transaction.putRecord("Artifact", adapterVersionId, 0, artifact);
          transaction.appendEvent("pkr.adapter.activated", "Artifact", adapterVersionId, 1, {
            candidateId,
            candidateDigest: candidate.contentDigest,
            replaced: active.record.id,
          });
          return transaction.committed({
            candidateId,
            adapterVersionId,
            replaced: active.record.id,
            contentDigest: adapterContentDigest,
          });
        },
      );
    }
    if (candidate.candidate.targetKind === "policy") {
      const active = this.readPolicyVersion(candidate.candidate.targetId);
      const activePolicies = this.listRecords("Constraint").filter((record) => {
        const extension = (record.data.extensions as JsonObject)["pkr.policy/version"] as JsonObject | undefined;
        return extension?.state === "active";
      });
      if (
        active.phase !== "active" ||
        active.contentDigest !== candidate.candidate.activeVersion ||
        activePolicies.length !== 1 ||
        activePolicies[0]!.id !== active.record.id
      ) {
        throw new PkrError(
          "PKR-EVOLUTION-004",
          "Policy candidate active-version basis is stale",
          "conflict",
        );
      }
      const policyId = derivedId("constraint", `${commandId}:policy`);
      const policyContent = candidate.candidate.policy!;
      const policyContentDigest = digest(policyContent);
      const constraint = constraintObject({
        id: policyId,
        projectId: this.projectId,
        title: policyContent.title,
        rule: policyContent.rule,
        scopeKinds: policyContent.scopeKinds,
        severity: policyContent.severity,
        enforcement: policyContent.enforcement,
        createdBy: promoterId,
        relations: [{
          type: "supersedes",
          target: { kind: "Constraint", id: active.record.id },
          required: true,
        }],
      });
      constraint.extensions = {
        "pkr.policy/version": {
          version: policyContent.version,
          contentDigest: policyContentDigest,
          state: "active",
          content: policyContent as unknown as JsonObject,
        },
        "pkr.evolution/candidate": {
          candidateId,
          candidateDigest: candidate.contentDigest,
          decisionId: decision.id,
          verificationId: passing.id,
          proposerId: candidate.proposerId,
          verifierId,
          promoterId,
        },
      };
      const retired = revisePom(active.record.data, active.record.revision + 1, {
        phase: "retired",
        reason: "PolicySuperseded",
      });
      retired.extensions = {
        ...(retired.extensions as JsonObject),
        "pkr.policy/version": {
          ...((retired.extensions as JsonObject)["pkr.policy/version"] as JsonObject),
          state: "retired",
        },
      };
      this.contracts.validateObject(constraint);
      this.contracts.validateObject(retired);
      return this.mutate(
        commandId,
        {
          action: "promotePolicyCandidate",
          candidateId,
          candidateDigest: candidate.contentDigest,
          policyId,
          replaced: active.record.id,
          decisionId: decision.id,
          verificationId: passing.id,
        },
        (transaction) => {
          transaction.putRecord("Constraint", active.record.id, active.record.revision, retired);
          transaction.appendEvent(
            "pkr.policy.retired",
            "Constraint",
            active.record.id,
            active.record.revision + 1,
            { supersededBy: policyId, candidateId },
          );
          transaction.putRecord("Constraint", policyId, 0, constraint);
          transaction.appendEvent("pkr.policy.activated", "Constraint", policyId, 1, {
            candidateId,
            candidateDigest: candidate.contentDigest,
            replaced: active.record.id,
          });
          return transaction.committed({
            candidateId,
            policyId,
            replaced: active.record.id,
            contentDigest: policyContentDigest,
          });
        },
      );
    }
    if (candidate.candidate.targetKind === "prompt") {
      const active = this.readPromptVersion(candidate.candidate.targetId);
      if (active.phase !== "active" || active.contentDigest !== candidate.candidate.activeVersion) {
        throw new PkrError("PKR-EVOLUTION-004", "Prompt candidate active-version basis is stale", "conflict");
      }
      const promptId = derivedId("prompt", `${commandId}:prompt`);
      const promptContentDigest = digest(candidate.candidate.prompt!.template);
      const prompt = knowledgeObject({
        id: promptId,
        projectId: this.projectId,
        title: candidate.candidate.prompt!.title,
        content: candidate.candidate.prompt!.template,
        sourceUri: `pkr://${this.projectId}/evolution/${candidateId}`,
        sourceDigest: candidate.contentDigest,
        createdBy: promoterId,
        knowledgeType: "prompt",
        relations: [{
          type: "supersedes",
          target: { kind: "Knowledge", id: active.record.id },
          required: true,
        }],
      });
      prompt.extensions = {
        "pkr.prompt/version": {
          version: candidate.candidate.prompt!.version,
          contentDigest: promptContentDigest,
          state: "active",
          variables: candidate.candidate.prompt!.variables,
        },
        "pkr.evolution/candidate": {
          candidateId,
          candidateDigest: candidate.contentDigest,
          decisionId: decision.id,
          verificationId: passing.id,
          proposerId: candidate.proposerId,
          verifierId,
          promoterId,
        },
      };
      const deprecated = revisePom(active.record.data, active.record.revision + 1, {
        phase: "deprecated",
        reason: "PromptSuperseded",
      });
      deprecated.extensions = {
        ...(deprecated.extensions as JsonObject),
        "pkr.prompt/version": {
          ...((deprecated.extensions as JsonObject)["pkr.prompt/version"] as JsonObject),
          state: "deprecated",
        },
      };
      this.contracts.validateObject(prompt);
      this.contracts.validateObject(deprecated);
      return this.mutate(
        commandId,
        {
          action: "promotePromptCandidate",
          candidateId,
          candidateDigest: candidate.contentDigest,
          promptId,
          replaced: active.record.id,
          decisionId: decision.id,
          verificationId: passing.id,
        },
        (transaction) => {
          transaction.putRecord("Knowledge", active.record.id, active.record.revision, deprecated);
          transaction.appendEvent(
            "pkr.prompt.deprecated",
            "Knowledge",
            active.record.id,
            active.record.revision + 1,
            { supersededBy: promptId, candidateId },
          );
          transaction.putRecord("Knowledge", promptId, 0, prompt);
          transaction.appendEvent("pkr.prompt.activated", "Knowledge", promptId, 1, {
            candidateId,
            candidateDigest: candidate.contentDigest,
            replaced: active.record.id,
          });
          return transaction.committed({
            candidateId,
            promptId,
            replaced: active.record.id,
            contentDigest: promptContentDigest,
          });
        },
      );
    }
    const active = this.listRecords("PackageInstallation").find(
      (record) => record.data.packageId === candidate.candidate.targetId && record.data.state === "active",
    );
    if (!active || active.data.version !== candidate.candidate.activeVersion) {
      throw new PkrError("PKR-EVOLUTION-004", "candidate active-version basis is stale", "conflict");
    }
    return this.installProfilePackage(
      candidate.candidate.profile!,
      decision.id,
      candidate.candidate.profile!.requestedCapabilities,
      promoterId,
      commandId,
      false,
      {
        candidateId,
        candidateDigest: candidate.contentDigest,
        decisionId: decision.id,
        verificationId: passing.id,
        proposerId: candidate.proposerId,
        verifierId,
        promoterId,
      },
    );
  }

  async monitorEvolutionCandidate(
    candidateId: string,
    observerId: string,
    value: string | number | boolean,
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    const candidate = this.readEvolutionCandidate(candidateId);
    this.assertEvolutionCandidateCurrent(candidateId);
    if (candidate.candidate.targetKind === "runtime") {
      throw new PkrError(
        "PKR-EVOLUTION-006",
        "Runtime candidates must be monitored by their external supervisor after out-of-process activation",
      );
    }
    const activation = [
      ...this.listRecords("PackageInstallation"),
      ...this.listRecords("Knowledge"),
      ...this.listRecords("Constraint"),
      ...this.listRecords("Artifact"),
    ].find((record) => {
      const binding = (record.data.extensions as JsonObject)["pkr.evolution/candidate"] as JsonObject | undefined;
      return binding?.candidateId === candidateId && binding.candidateDigest === candidate.contentDigest;
    });
    const activationActive = activation && (
      (activation.kind === "PackageInstallation" && activation.data.state === "active") ||
      (candidate.candidate.targetKind === "prompt" &&
        (activation.data.status as JsonObject).phase === "active") ||
      (candidate.candidate.targetKind === "policy" &&
        ((activation.data.extensions as JsonObject)["pkr.policy/version"] as JsonObject | undefined)?.state === "active") ||
      (candidate.candidate.targetKind === "adapter" &&
        ((activation.data.extensions as JsonObject)["pkr.adapter/version"] as JsonObject | undefined)?.state === "active")
    );
    if (!activation || !activationActive) {
      throw new PkrError(
        "PKR-EVOLUTION-014",
        "post-promotion monitoring requires the candidate's exact active version",
        "conflict",
      );
    }
    const binding = (activation.data.extensions as JsonObject)["pkr.evolution/candidate"] as JsonObject;
    const decision = this.acceptedEvolutionDecision(candidateId, candidate.contentDigest);
    const passing = this.listRecords("Verification").find((record) => {
      const verificationBinding = (record.data.extensions as JsonObject)["pkr.evolution/candidate"] as JsonObject | undefined;
      return record.id === binding.verificationId &&
        verificationBinding?.candidateId === candidateId &&
        verificationBinding.candidateDigest === candidate.contentDigest &&
        (record.data.status as JsonObject).phase === "passed";
    });
    if (
      !decision ||
      decision.id !== binding.decisionId ||
      !passing ||
      passing.id !== binding.verificationId
    ) {
      throw new PkrError(
        "PKR-EVOLUTION-014",
        "active candidate has inconsistent Decision or Verification bindings",
        "conflict",
      );
    }
    const excludedObservers = new Set([
      candidate.proposerId,
      (decision.data.metadata as JsonObject).createdBy as string,
      ((passing.data.status as JsonObject).executor as JsonObject).principalId as string,
      binding.promoterId as string | undefined,
    ].filter((principal): principal is string => typeof principal === "string"));
    if (!observerId || excludedObservers.has(observerId)) {
      throw new PkrError(
        "PKR-EVOLUTION-002",
        "post-promotion observer must be distinct from proposer, verifier, approver, and promoter",
      );
    }
    const priorMonitoring = this.listRecords("Metric").filter((record) => {
      const monitoring = (record.data.extensions as JsonObject)["pkr.evolution/monitoring"] as JsonObject | undefined;
      return monitoring?.candidateId === candidateId &&
        monitoring.candidateDigest === candidate.contentDigest &&
        monitoring.activationId === activation.id;
    });
    if (priorMonitoring.some((record) =>
      ((record.data.extensions as JsonObject)["pkr.evolution/monitoring"] as JsonObject).thresholdSatisfied === false
    )) {
      throw new PkrError(
        "PKR-EVOLUTION-014",
        "monitoring already breached; owner rollback is required before further observations",
        "conflict",
      );
    }
    if (priorMonitoring.length >= candidate.candidate.monitoring.maxObservations) {
      throw new PkrError(
        "PKR-EVOLUTION-013",
        "post-promotion monitoring observation budget is exhausted",
      );
    }
    const thresholdSatisfied = metricThresholdSatisfied(
      value,
      candidate.candidate.monitoring.threshold,
    );
    const metricId = derivedId("metric", commandId);
    const metric = metricObject({
      id: metricId,
      projectId: this.projectId,
      measure: candidate.candidate.monitoring.measure,
      sourceAdapter: "pkr/evolution-monitor",
      sourceConfiguration: {
        candidateId,
        candidateDigest: candidate.contentDigest,
        activationKind: activation.kind,
        activationId: activation.id,
      },
      window: candidate.candidate.monitoring.window,
      threshold: candidate.candidate.monitoring.threshold,
      value,
      thresholdSatisfied,
      createdBy: observerId,
    });
    metric.extensions = {
      ...(metric.extensions as JsonObject),
      "pkr.evolution/monitoring": {
        candidateId,
        candidateDigest: candidate.contentDigest,
        activationKind: activation.kind,
        activationId: activation.id,
        observerId,
        observation: priorMonitoring.length + 1,
        maxObservations: candidate.candidate.monitoring.maxObservations,
        thresholdSatisfied,
        onBreach: candidate.candidate.monitoring.onBreach,
      },
    };
    this.contracts.validateObject(metric);
    return this.mutate(
      commandId,
      {
        action: "monitorEvolutionCandidate",
        candidateId,
        candidateDigest: candidate.contentDigest,
        activationId: activation.id,
        observerId,
        value,
      },
      (transaction) => {
        transaction.putRecord("Metric", metricId, 0, metric);
        transaction.appendEvent(
          thresholdSatisfied
            ? "pkr.evolution.monitoringPassed"
            : "pkr.evolution.monitoringBreached",
          "Metric",
          metricId,
          1,
          {
            candidateId,
            candidateDigest: candidate.contentDigest,
            activationId: activation.id,
            thresholdSatisfied,
            rollbackRequired: !thresholdSatisfied,
          },
        );
        return transaction.committed({
          candidateId,
          candidateDigest: candidate.contentDigest,
          activationId: activation.id,
          monitoringId: metricId,
          state: thresholdSatisfied ? "healthy" : "breached",
          rollbackRequired: !thresholdSatisfied,
        });
      },
    );
  }

  evolutionCandidateStatus(candidateId: string): JsonObject {
    const candidate = this.readEvolutionCandidate(candidateId);
    const supersededBy = this.evolutionCandidateSupersededBy(candidateId);
    const decision = this.acceptedEvolutionDecision(candidateId, candidate.contentDigest);
    const verifications = this.listRecords("Verification").filter((record) => {
      const binding = (record.data.extensions as JsonObject)["pkr.evolution/candidate"] as JsonObject | undefined;
      return binding?.candidateId === candidateId && binding.candidateDigest === candidate.contentDigest;
    });
    const installation = this.listRecords("PackageInstallation").find((record) => {
      const binding = (record.data.extensions as JsonObject)["pkr.evolution/candidate"] as JsonObject | undefined;
      return binding?.candidateId === candidateId && binding.candidateDigest === candidate.contentDigest;
    });
    const promptActivation = this.listRecords("Knowledge").find((record) => {
      const binding = (record.data.extensions as JsonObject)["pkr.evolution/candidate"] as JsonObject | undefined;
      return binding?.candidateId === candidateId && binding.candidateDigest === candidate.contentDigest;
    });
    const policyActivation = this.listRecords("Constraint").find((record) => {
      const binding = (record.data.extensions as JsonObject)["pkr.evolution/candidate"] as JsonObject | undefined;
      return binding?.candidateId === candidateId && binding.candidateDigest === candidate.contentDigest;
    });
    const adapterActivation = this.listRecords("Artifact").find((record) => {
      const spec = record.data.spec as JsonObject;
      const binding = (record.data.extensions as JsonObject)["pkr.evolution/candidate"] as JsonObject | undefined;
      return spec.artifactType === "pkr/adapter-version" &&
        binding?.candidateId === candidateId &&
        binding.candidateDigest === candidate.contentDigest;
    });
    const monitoring = this.listRecords("Metric").filter((record) => {
      const binding = (record.data.extensions as JsonObject)["pkr.evolution/monitoring"] as JsonObject | undefined;
      return binding?.candidateId === candidateId && binding.candidateDigest === candidate.contentDigest;
    });
    const monitoringBreached = monitoring.some((record) =>
      ((record.data.extensions as JsonObject)["pkr.evolution/monitoring"] as JsonObject).thresholdSatisfied === false
    );
    const promptRolledBack = promptActivation
      ? this.listEvents().some((event) =>
          event.type === "pkr.prompt.rolledBack" && event.data.from === promptActivation.id,
        )
      : false;
    const policyRolledBack = policyActivation
      ? this.listEvents().some((event) =>
          event.type === "pkr.policy.rolledBack" && event.data.from === policyActivation.id,
        )
      : false;
    const adapterRolledBack = adapterActivation
      ? this.listEvents().some((event) =>
          event.type === "pkr.adapter.rolledBack" && event.data.from === adapterActivation.id,
        )
      : false;
    const passed = verifications.some((record) => (record.data.status as JsonObject).phase === "passed");
    const failed = verifications.some((record) => (record.data.status as JsonObject).phase === "failed");
    const state = supersededBy
      ? "superseded"
      : policyActivation
        ? (policyActivation.data.status as JsonObject).phase === "active"
          ? "active"
          : policyRolledBack ? "rolledBack" : "superseded"
      : adapterActivation
        ? ((adapterActivation.data.extensions as JsonObject)["pkr.adapter/version"] as JsonObject).state === "active"
          ? "active"
          : adapterRolledBack ? "rolledBack" : "superseded"
      : promptActivation
        ? (promptActivation.data.status as JsonObject).phase === "active"
          ? "active"
          : promptRolledBack ? "rolledBack" : "superseded"
      : installation
      ? installation.data.state === "active" ? "active" : "rolledBack"
      : failed ? "rejected" : passed ? "verified" : decision ? "approved" : "proposed";
    return {
      candidateId,
      candidateDigest: candidate.contentDigest,
      state,
      immutable: true,
      supersededBy: supersededBy?.id ?? null,
      decisionId: decision?.id ?? null,
      verificationIds: verifications.map((record) => record.id),
      activationId: policyActivation?.id ?? adapterActivation?.id ?? promptActivation?.id ?? installation?.id ?? null,
      policyId: policyActivation?.id ?? null,
      adapterVersionId: adapterActivation?.id ?? null,
      promptId: promptActivation?.id ?? null,
      installationId: installation?.id ?? null,
      monitoringIds: monitoring.map((record) => record.id),
      monitoringState: monitoring.length === 0
        ? (state === "active" ? "pending" : null)
        : monitoringBreached ? "breached" : "healthy",
      rollbackRequired: monitoringBreached && state === "active",
    };
  }

  private readEvolutionCandidate(candidateId: string): {
    record: StoredRecord;
    candidate: EvolutionCandidateSpec;
    contentDigest: string;
    proposerId: string;
  } {
    const record = this.getRecord("Artifact", candidateId);
    const artifactSpec = record.data.spec as JsonObject;
    const extension = (record.data.extensions as JsonObject)["pkr.evolution/candidate"] as JsonObject | undefined;
    if (artifactSpec.artifactType !== "pkr/evolution-candidate" || !extension) {
      throw new PkrError("PKR-EVOLUTION-003", `${candidateId} is not an evolution candidate`);
    }
    const content = extension.content as JsonObject;
    const contentDigest = extension.contentDigest as string;
    if (!content || contentDigest !== digest(content) || artifactSpec.digest !== contentDigest) {
      throw new PkrError("PKR-EVOLUTION-003", "candidate content digest is inconsistent", "conflict");
    }
    const candidate = content as unknown as EvolutionCandidateSpec;
    validateEvolutionCandidate(candidate);
    return {
      record,
      candidate,
      contentDigest,
      proposerId: extension.proposerId as string,
    };
  }

  private readPromptVersion(promptId: string): {
    record: StoredRecord;
    version: string;
    contentDigest: string;
    phase: string;
    template: string;
  } {
    const record = this.getRecord("Knowledge", promptId);
    const spec = record.data.spec as JsonObject;
    const status = record.data.status as JsonObject;
    const extension = (record.data.extensions as JsonObject)["pkr.prompt/version"] as JsonObject | undefined;
    if (spec.knowledgeType !== "prompt" || typeof spec.content !== "string" || !extension) {
      throw new PkrError("PKR-EVOLUTION-008", `${promptId} is not a managed Prompt version`);
    }
    const contentDigest = extension.contentDigest as string;
    const version = extension.version as string;
    const phase = status.phase as string;
    const variables = extension.variables;
    if (
      !version ||
      contentDigest !== digest(spec.content) ||
      !Array.isArray(variables) ||
      JSON.stringify([...variables].sort()) !==
        JSON.stringify(promptTemplateVariables(spec.content).sort()) ||
      extension.state !== phase ||
      !["active", "deprecated"].includes(phase)
    ) {
      throw new PkrError(
        "PKR-EVOLUTION-008",
        `Prompt ${promptId} version metadata is inconsistent`,
        "conflict",
      );
    }
    return { record, version, contentDigest, phase, template: spec.content };
  }

  private readPolicyVersion(policyId: string): {
    record: StoredRecord;
    version: string;
    contentDigest: string;
    phase: "active" | "retired";
    policy: GovernancePolicyContent;
  } {
    const record = this.getRecord("Constraint", policyId);
    const spec = record.data.spec as JsonObject;
    const status = record.data.status as JsonObject;
    const extension = (record.data.extensions as JsonObject)["pkr.policy/version"] as JsonObject | undefined;
    if (!extension?.content || Array.isArray(extension.content) || typeof extension.content !== "object") {
      throw new PkrError("PKR-EVOLUTION-010", `${policyId} is not a managed Policy version`);
    }
    const policy = extension.content as unknown as GovernancePolicyContent;
    validateGovernancePolicy(policy);
    const phase = status.phase;
    if (
      !["active", "retired"].includes(phase as string) ||
      extension.state !== phase ||
      extension.version !== policy.version ||
      extension.contentDigest !== digest(policy) ||
      spec.rule !== policy.rule ||
      JSON.stringify((spec.scope as JsonObject).kinds) !== JSON.stringify(policy.scopeKinds) ||
      spec.severity !== policy.severity ||
      spec.enforcement !== policy.enforcement
    ) {
      throw new PkrError(
        "PKR-EVOLUTION-010",
        `Policy ${policyId} version metadata is inconsistent`,
        "conflict",
      );
    }
    return {
      record,
      version: policy.version,
      contentDigest: extension.contentDigest as string,
      phase: phase as "active" | "retired",
      policy,
    };
  }

  private readAdapterVersion(adapterVersionId: string): {
    record: StoredRecord;
    contentDigest: string;
    phase: "active" | "retired";
    adapter: ManagedAdapterContent;
  } {
    const record = this.getRecord("Artifact", adapterVersionId);
    const spec = record.data.spec as JsonObject;
    const status = record.data.status as JsonObject;
    const extension = (record.data.extensions as JsonObject)["pkr.adapter/version"] as JsonObject | undefined;
    if (
      spec.artifactType !== "pkr/adapter-version" ||
      !extension?.content ||
      Array.isArray(extension.content) ||
      typeof extension.content !== "object"
    ) {
      throw new PkrError("PKR-EVOLUTION-012", `${adapterVersionId} is not a managed Adapter version`);
    }
    const adapter = extension.content as unknown as ManagedAdapterContent;
    validateManagedAdapter(adapter);
    const phase = extension.state;
    const sourceDigests = (spec.provenance as JsonObject).sourceDigests;
    if (
      !["active", "retired"].includes(phase as string) ||
      (phase === "active" ? status.phase !== "available" : status.phase !== "archived") ||
      extension.adapterId !== adapter.adapterId ||
      extension.version !== adapter.version ||
      extension.contentDigest !== digest(adapter) ||
      spec.digest !== extension.contentDigest ||
      !Array.isArray(sourceDigests) ||
      sourceDigests.length !== 1 ||
      sourceDigests[0] !== adapter.implementationDigest
    ) {
      throw new PkrError(
        "PKR-EVOLUTION-012",
        `Adapter ${adapterVersionId} version metadata is inconsistent`,
        "conflict",
      );
    }
    return {
      record,
      contentDigest: extension.contentDigest as string,
      phase: phase as "active" | "retired",
      adapter,
    };
  }

  private resolveProviderAdapterBinding(binding: ProviderAdapterBinding): {
    id: string;
    version: string;
    capabilities: string[];
    protocolVersion: "pkr.dev/v0.4";
    adapterVersionId: string | null;
    contentDigest: string | null;
    isolation: {
      filesystem: "none" | "scoped" | "unrestricted";
      network: "none" | "scoped" | "unrestricted";
      credentials: "none" | "references-only" | "host-managed";
    };
  } {
    if (
      !binding.id?.trim() ||
      !binding.version?.trim() ||
      !Array.isArray(binding.capabilities) ||
      binding.capabilities.length === 0 ||
      binding.capabilities.some((capability) => typeof capability !== "string" || !capability) ||
      new Set(binding.capabilities).size !== binding.capabilities.length
    ) {
      throw new PkrError("PKR-EVOLUTION-012", "Provider Adapter binding is incomplete");
    }
    const activeRecords = this.listRecords("Artifact").filter((record) => {
      const extension = (record.data.extensions as JsonObject)["pkr.adapter/version"] as JsonObject | undefined;
      return extension?.adapterId === binding.id && extension.state === "active";
    });
    if (activeRecords.length > 1) {
      throw new PkrError(
        "PKR-EVOLUTION-012",
        `Adapter ${binding.id} has multiple active managed versions`,
        "conflict",
      );
    }
    const active = activeRecords[0] ? this.readAdapterVersion(activeRecords[0].id) : undefined;
    if (active) {
      const sameCapabilities = JSON.stringify([...binding.capabilities].sort()) ===
        JSON.stringify([...active.adapter.capabilities].sort());
      if (binding.version !== active.adapter.version || !sameCapabilities) {
        throw new PkrError(
          "PKR-EVOLUTION-012",
          `Provider ${binding.id}@${binding.version} does not match active Adapter ` +
            `${active.adapter.version} and its exact capability declaration`,
          "conflict",
        );
      }
      return {
        id: active.adapter.adapterId,
        version: active.adapter.version,
        capabilities: [...active.adapter.capabilities],
        protocolVersion: active.adapter.protocolVersion,
        adapterVersionId: active.record.id,
        contentDigest: active.contentDigest,
        isolation: { ...active.adapter.isolation },
      };
    }

    const builtin = BUILTIN_ADAPTER_BINDINGS.find((candidate) => candidate.id === binding.id);
    const sameBuiltinCapabilities = builtin &&
      JSON.stringify([...binding.capabilities].sort()) ===
        JSON.stringify([...builtin.capabilities].sort());
    if (!builtin || binding.version !== builtin.version || !sameBuiltinCapabilities) {
      throw new PkrError(
        "PKR-EVOLUTION-012",
        `Provider ${binding.id}@${binding.version} has no active managed Adapter contract`,
      );
    }
    return {
      id: builtin.id,
      version: builtin.version,
      capabilities: [...builtin.capabilities],
      protocolVersion: "pkr.dev/v0.4",
      adapterVersionId: null,
      contentDigest: null,
      isolation: { ...builtin.isolation },
    };
  }

  private acceptedEvolutionDecision(
    candidateId: string,
    candidateDigest: string,
  ): StoredRecord | undefined {
    return this.listRecords("Decision").find((record) => {
      const binding = (record.data.extensions as JsonObject)["pkr.evolution/candidate"] as JsonObject | undefined;
      return binding?.candidateId === candidateId &&
        binding.candidateDigest === candidateDigest &&
        (record.data.status as JsonObject).phase === "accepted";
    });
  }

  private evolutionCandidateSupersededBy(candidateId: string): StoredRecord | undefined {
    return this.listRecords("Artifact").find((record) => {
      const spec = record.data.spec as JsonObject;
      return spec.artifactType === "pkr/evolution-candidate" &&
        (record.data.relations as JsonObject[]).some((relation) =>
          relation.type === "supersedes" &&
          (relation.target as JsonObject).kind === "Artifact" &&
          (relation.target as JsonObject).id === candidateId,
        );
    });
  }

  private assertEvolutionCandidateCurrent(candidateId: string): void {
    const supersededBy = this.evolutionCandidateSupersededBy(candidateId);
    if (supersededBy) {
      throw new PkrError(
        "PKR-EVOLUTION-003",
        `candidate ${candidateId} was superseded by ${supersededBy.id}`,
        "conflict",
      );
    }
  }

  private executionWorkflowRun(taskId: string, assignmentId: string): StoredRecord | undefined {
    const runs = this.listRecords("WorkflowRun").filter(
      (record) => ((record.data.scope as JsonObject).taskId as string) === taskId,
    );
    return runs.find((record) => {
      const execution = (record.data.extensions as JsonObject)["pkr.execution/mode"] as
        JsonObject | undefined;
      return execution?.assignmentId === assignmentId;
    }) ?? (runs.length === 1 ? runs[0] : undefined);
  }

  private executionExpired(session: StoredRecord, lease: StoredRecord): boolean {
    const sessionExpiry = Date.parse(session.data.expiresAt as string);
    const leaseExpiry = Date.parse(lease.data.expiresAt as string);
    if (!Number.isFinite(sessionExpiry) || !Number.isFinite(leaseExpiry)) {
      throw new PkrError("PKR-RECOVERY-001", "execution has an invalid expiry timestamp");
    }
    return Math.min(sessionExpiry, leaseExpiry) <= Date.now();
  }

  stateDigest(): string {
    return this.store.stateDigest(this.projectId);
  }

  async rebuildProjections(): Promise<void> {
    await rebuildProjections(
      this.store,
      this.projectId,
      this.paths.stateDir,
      this.paths.projections,
    );
  }

  private async mutate<T extends JsonValue>(
    commandId: string,
    content: JsonObject,
    operation: (transaction: StoreTransaction) => CommandResult<T>,
  ): Promise<CommandResult<T>> {
    const { result } = this.store.execute(
      this.projectId,
      commandId,
      commandContent(content),
      operation,
    );
    await this.rebuildProjections();
    return result;
  }
}
