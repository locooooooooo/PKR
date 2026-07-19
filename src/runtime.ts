import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ContractValidator } from "./contracts.js";
import { PkrError } from "./errors.js";
import {
  accountableOwner,
  agentObject,
  artifactObject,
  decisionObject,
  goalObject,
  governanceWorkflowObject,
  knowledgeObject,
  missionObject,
  ownerRoleObject,
  profileWorkflowObject,
  reviseControl,
  revisePom,
  taskObject,
  verificationObject,
} from "./objects.js";
import type { ProfilePackage } from "./profiles.js";
import { rebuildProjections } from "./projection.js";
import { PkrStore, commandContent, type StoreTransaction } from "./store.js";
import type {
  CommandResult,
  InitOptions,
  JsonObject,
  JsonValue,
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
    return new PkrRuntime(
      paths,
      repositoryRoot,
      projectId,
      store,
      new ContractValidator(repositoryRoot),
    );
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
      recordCounts: counts,
    };
  }

  ownerId(): string {
    const manifest = this.getRecord("ProjectManifest", this.projectId).data;
    return (manifest.metadata as JsonObject).createdBy as string;
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
    });
    this.contracts.validateObject(task);
    return this.mutate(commandId, { action: "createTask", taskId, goalId, objective }, (transaction) => {
      transaction.putRecord("Task", taskId, 0, task);
      transaction.appendEvent("pkr.task.created", "Task", taskId, 1);
      return transaction.committed(task);
    });
  }

  async registerAgent(
    name: string,
    provider: string,
    actorId = "human_001",
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    const agentId = derivedId("agent", commandId);
    const registered = agentObject({
      id: agentId,
      projectId: this.projectId,
      name: slug(name),
      provider: slug(provider),
      createdBy: actorId,
    });
    const active = agentObject({
      id: agentId,
      projectId: this.projectId,
      name: slug(name),
      provider: slug(provider),
      createdBy: actorId,
      revision: 2,
      phase: "active",
    });
    this.contracts.validateObject(registered);
    this.contracts.validateObject(active);
    return this.mutate(commandId, { action: "registerAgent", agentId, name, provider }, (transaction) => {
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
    });
    this.contracts.validateObject(proposed);
    this.contracts.validateObject(accepted);
    return this.mutate(
      commandId,
      { action: "createDecision", decisionId, question, choice, reason, affectedKinds },
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
  ): Promise<CommandResult<JsonObject>> {
    const command = commandContent({ action: "dispatch", taskId, agentId });
    const replay = this.store.replay<JsonObject>(this.projectId, commandId, command);
    if (replay) {
      return replay;
    }
    const taskRecord = this.getRecord("Task", taskId);
    if ((taskRecord.data.status as JsonObject).phase !== "backlog") {
      throw new PkrError(
        "PKR-COORD-006",
        "dispatch requires a backlog Task without a live Assignment",
        "conflict",
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
        reason: "ReadyForExecution",
        acceptanceResults: [],
      });
      this.contracts.validateObject(ready);
      transaction.putRecord("Task", taskId, taskRecord.revision, ready);
      transaction.appendEvent("pkr.task.phaseChanged", "Task", taskId, taskRecord.revision + 1, { from: "backlog", to: "ready" });
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
        adapter: { id: "pkr.adapter.local-process", version: "0.5.0" },
        protocolVersions: ["pkr.dev/v0.4"],
        capabilities: ["filesystem.read", "filesystem.write", "terminal"],
        limits: { maxConcurrency: 1, maxDurationSeconds: 3600 },
        isolation: {
          filesystem: "scoped",
          network: "none",
          credentials: "references-only",
        },
        issuedAt: createdAt,
        expiresAt,
        extensions: {},
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
        providerLocator: `local://${sessionId}`,
        adapter: { id: "pkr.adapter.local-process", version: "0.5.0" },
        protocolVersion: "pkr.dev/v0.4",
        capabilityStatementId,
        assignmentIds: [assignmentId],
        state: "active",
        lastHeartbeat: createdAt,
        expiresAt,
        extensions: {},
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
        extensions: {},
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
        requiredCapabilities: ["filesystem.read", "filesystem.write", "terminal"],
        expectedArtifacts: ["pkr/source-change"],
        callbackContract: {
          outcomes: ["verified", "partial", "blocked", "externalSignoffBlocked"],
          evidenceRequired: true,
        },
        state: "offered",
        extensions: {},
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
    details: {
      completed: string[];
      incomplete: string[];
      blockers: string[];
      nextAction: string;
    } = { completed: [], incomplete: [], blockers: [], nextAction: "verify" },
  ): Promise<CommandResult<JsonObject>> {
    const command = commandContent({ action: "callback", assignmentId, outcome, evidenceIds, details });
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
    const runRecord = this.listRecords("WorkflowRun").find(
      (record) => ((record.data.scope as JsonObject).taskId as string) === taskId,
    );
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
        payload: { outcome, evidenceIds, ...details },
        extensions: {},
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

      const nextTaskPhase = outcome === "verified" ? "verifying" : "blocked";
      const verifying = revisePom(taskRecord.data, taskRecord.revision + 1, {
        phase: nextTaskPhase,
        reason: outcome === "verified" ? "CallbackSubmitted" : "ExecutionNotVerified",
        acceptanceResults: [],
      });
      this.contracts.validateObject(verifying);
      transaction.putRecord("Task", taskId, taskRecord.revision, verifying);
      transaction.appendEvent("pkr.task.phaseChanged", "Task", taskId, taskRecord.revision + 1, { from: "inProgress", to: nextTaskPhase });

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
        const nextRunState = outcome === "verified" ? "verifying" : "blocked";
        const nextRun = reviseControl(
          runRecord.data,
          runRecord.revision + 1,
          transaction.currentSequence() + 1,
          {
            state: nextRunState,
            activeSteps: outcome === "verified" ? ["verify"] : [],
            completedSteps: ["plan", "implement"],
          },
        );
        this.contracts.validateCoordination(nextRun);
        transaction.putRecord("WorkflowRun", runRecord.id, runRecord.revision, nextRun);
        transaction.appendEvent("pkr.workflowRun.transitioned", "WorkflowRun", runRecord.id, runRecord.revision + 1, { from: "implementing", to: nextRunState });
      }
      return transaction.committed({ assignmentId, messageId, taskId, outcome });
    });
  }

  async verify(
    taskId: string,
    assignmentId: string,
    actorId = "agent_verifier",
    commandId = newId("command"),
  ): Promise<CommandResult<JsonObject>> {
    const command = commandContent({ action: "verify", taskId, assignmentId });
    const replay = this.store.replay<JsonObject>(this.projectId, commandId, command);
    if (replay) {
      return replay;
    }
    const taskRecord = this.getRecord("Task", taskId);
    const assignmentRecord = this.getRecord("Assignment", assignmentId);
    if ((taskRecord.data.status as JsonObject).phase !== "verifying") {
      throw new PkrError("PKR-POM-006", "Task must be verifying before completion");
    }
    if (assignmentRecord.data.state !== "submitted" || assignmentRecord.data.disposition !== "verified") {
      throw new PkrError("PKR-COORD-008", "verified submitted callback is required");
    }
    const artifactId = derivedId("artifact", `${commandId}:artifact`);
    const testVerificationId = derivedId("verification", `${commandId}:test`);
    const acceptanceVerificationId = derivedId("verification", `${commandId}:acceptance`);
    const leaseRecord = this.listRecords("Lease").find(
      (record) => record.data.assignmentId === assignmentId,
    );
    const sessionRecord = leaseRecord
      ? this.store.getRecord(
          this.projectId,
          "AgentSession",
          leaseRecord.data.sessionId as string,
        )
      : undefined;
    const runRecord = this.listRecords("WorkflowRun").find(
      (record) => ((record.data.scope as JsonObject).taskId as string) === taskId,
    );
    const callbackMessage = this.listRecords("AgentMessage").find(
      (record) => record.data.assignmentId === assignmentId,
    );
    const evidenceIds = callbackMessage
      ? (((callbackMessage.data.payload as JsonObject).evidenceIds as JsonValue[]) ?? [])
      : [];
    const artifactDigest = digest({
      assignmentId,
      callback: assignmentRecord.data.disposition,
      evidenceIds,
    });
    const artifact = artifactObject({
      id: artifactId,
      projectId: this.projectId,
      taskId,
      digest: artifactDigest,
      commandId,
      createdBy: actorId,
    });
    const testVerification = verificationObject({
      id: testVerificationId,
      projectId: this.projectId,
      taskId,
      taskRevision: taskRecord.revision,
      artifactId,
      createdBy: actorId,
      gate: "test",
    });
    const acceptanceVerification = verificationObject({
      id: acceptanceVerificationId,
      projectId: this.projectId,
      taskId,
      taskRevision: taskRecord.revision,
      artifactId,
      createdBy: actorId,
      gate: "acceptance",
    });
    this.contracts.validateObject(artifact);
    this.contracts.validateObject(testVerification);
    this.contracts.validateObject(acceptanceVerification);

    return this.mutate(commandId, command, (transaction) => {
      transaction.putRecord("Artifact", artifactId, 0, artifact);
      transaction.appendEvent("pkr.artifact.available", "Artifact", artifactId, 1);
      transaction.putRecord("Verification", testVerificationId, 0, testVerification);
      transaction.appendEvent("pkr.verification.passed", "Verification", testVerificationId, 1, { gate: "test" });
      transaction.putRecord("Verification", acceptanceVerificationId, 0, acceptanceVerification);
      transaction.appendEvent("pkr.verification.passed", "Verification", acceptanceVerificationId, 1, { gate: "acceptance" });

      const relations = [...(taskRecord.data.relations as JsonValue[])];
      relations.push({
        type: "produces",
        target: { kind: "Artifact", id: artifactId },
        required: true,
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
              evidenceDigests: [artifactDigest],
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
      });
    });
  }

  workspace(taskId: string, assignmentId: string, principalId: string): JsonObject {
    const task = this.getRecord("Task", taskId);
    const assignment = this.getRecord("Assignment", assignmentId);
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
      notices: [],
      extensions: {},
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
    return this.mutate(commandId, command, (transaction) => {
      const observedAt = now();
      const expiresAt = new Date(Date.now() + HOUR_MS).toISOString();
      const nextSession = reviseControl(
        session.data,
        session.revision + 1,
        transaction.currentSequence() + 1,
        { lastHeartbeat: observedAt },
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
      return transaction.committed({ leaseId, assignmentId, taskId: task.id });
    });
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
      extensions: {},
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
        transaction.appendEvent("pkr.package.activated", "PackageInstallation", installationId, 2);
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
