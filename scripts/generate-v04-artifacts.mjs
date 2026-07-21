import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = join(root, "schemas", "v0.4");
const fixtureDir = join(root, "conformance", "v0.4");

const API_VERSION = "pkr.dev/v0.4";
const SCHEMA_ID = "https://pkr.dev/schemas/v0.4/pkr-coordination.schema.json";
const at = "2026-07-17T14:00:00Z";
const later = "2026-07-17T15:00:00Z";

const ref = (name) => ({ $ref: `#/$defs/${name}` });
const arrayOf = (items, minItems = 0) => ({
  type: "array",
  items,
  minItems,
  uniqueItems: true,
});
const strict = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const common = {
  ApiVersion: { const: API_VERSION },
  Id: {
    type: "string",
    pattern: "^[a-z][a-z0-9]*_[A-Za-z0-9][A-Za-z0-9._-]*$",
  },
  NonEmptyString: { type: "string", minLength: 1 },
  Revision: { type: "integer", minimum: 1 },
  Sequence: { type: "integer", minimum: 0 },
  Timestamp: { type: "string", format: "date-time" },
  Digest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
  Semver: {
    type: "string",
    pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$",
  },
  Extensions: {
    type: "object",
    propertyNames: {
      pattern: "^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)/[A-Za-z0-9_.-]+$",
    },
    additionalProperties: true,
  },
  Actor: strict({
    principalType: { enum: ["human", "agent", "service"] },
    principalId: ref("Id"),
  }),
  WorkflowRef: strict({ id: ref("Id"), revision: ref("Revision") }),
  TaskScope: strict({ type: { const: "task" }, taskId: ref("Id") }),
  GovernanceScope: strict({
    type: { const: "governance" },
    name: { type: "string", pattern: "^[a-z][a-z0-9.-]*/[a-z][a-z0-9.-]*$" },
  }),
  Scope: { oneOf: [ref("TaskScope"), ref("GovernanceScope")] },
  DecisionBasis: {
    oneOf: [
      strict({ type: { const: "decision" }, decisionId: ref("Id") }),
      strict({ type: { const: "operational" }, reason: ref("NonEmptyString") }),
    ],
  },
  StringList: arrayOf(ref("NonEmptyString")),
  IdList: arrayOf(ref("Id")),
  SourceRef: strict({
    kind: ref("NonEmptyString"),
    id: ref("Id"),
    revision: { type: "integer", minimum: 1 },
  }, ["kind", "id"]),
  EventRange: strict({
    firstSequence: { type: "integer", minimum: 1 },
    lastSequence: { type: "integer", minimum: 1 },
  }),
};

function controlRecord(kind, idField, properties, required = Object.keys(properties)) {
  return strict(
    {
      apiVersion: ref("ApiVersion"),
      kind: { const: kind },
      [idField]: ref("Id"),
      projectId: ref("Id"),
      revision: ref("Revision"),
      projectSequence: ref("Sequence"),
      createdAt: ref("Timestamp"),
      updatedAt: ref("Timestamp"),
      ...properties,
      extensions: ref("Extensions"),
    },
    [
      "apiVersion",
      "kind",
      idField,
      "projectId",
      "revision",
      "projectSequence",
      "createdAt",
      "updatedAt",
      ...required,
      "extensions",
    ],
  );
}

const workflowRun = controlRecord("WorkflowRun", "runId", {
  workflowId: ref("Id"),
  workflowRevision: ref("Revision"),
  scope: ref("Scope"),
  state: { type: "string", pattern: "^[a-z][A-Za-z0-9.-]*$" },
  activeSteps: ref("StringList"),
  completedSteps: ref("StringList"),
  pendingGates: {
    type: "array",
    items: { enum: ["build", "test", "security", "performance", "business", "acceptance"] },
    uniqueItems: true,
  },
});

const capabilityStatement = strict({
  apiVersion: ref("ApiVersion"),
  kind: { const: "CapabilityStatement" },
  capabilityStatementId: ref("Id"),
  projectId: ref("Id"),
  agentId: ref("Id"),
  adapter: strict({ id: ref("NonEmptyString"), version: ref("Semver") }),
  protocolVersions: arrayOf({ type: "string", pattern: "^pkr\\.dev/v[0-9]+\\.[0-9]+$" }, 1),
  capabilities: arrayOf({ type: "string", pattern: "^[a-z][a-z0-9.-]*$" }, 1),
  limits: strict({
    maxConcurrency: { type: "integer", minimum: 1 },
    maxDurationSeconds: { type: "integer", minimum: 1 },
  }),
  isolation: strict({
    filesystem: { enum: ["none", "scoped", "unrestricted"] },
    network: { enum: ["none", "scoped", "unrestricted"] },
    credentials: { enum: ["none", "references-only", "host-managed"] },
  }),
  issuedAt: ref("Timestamp"),
  expiresAt: ref("Timestamp"),
  extensions: ref("Extensions"),
});

const assignmentStates = [
  "prepared", "offered", "accepted", "running", "blocked", "submitted",
  "closed", "rejected", "cancelled", "expired", "failed",
];
const assignment = controlRecord("Assignment", "assignmentId", {
  idempotencyKey: ref("Id"),
  taskId: ref("Id"),
  taskRevision: ref("Revision"),
  workflowId: ref("Id"),
  workflowRevision: ref("Revision"),
  roleId: ref("Id"),
  objective: ref("NonEmptyString"),
  allowedScope: arrayOf(ref("NonEmptyString"), 1),
  forbiddenScope: arrayOf(ref("NonEmptyString")),
  acceptanceRefs: arrayOf(ref("NonEmptyString"), 1),
  verificationPolicyRef: ref("NonEmptyString"),
  requiredCapabilities: arrayOf(ref("NonEmptyString"), 1),
  expectedArtifacts: arrayOf(ref("NonEmptyString"), 1),
  callbackContract: strict({
    outcomes: arrayOf({ enum: ["verified", "partial", "blocked", "externalSignoffBlocked"] }, 1),
    evidenceRequired: { type: "boolean" },
  }),
  state: { enum: assignmentStates },
  disposition: { type: ["string", "null"] },
}, [
  "idempotencyKey", "taskId", "taskRevision", "workflowId", "workflowRevision",
  "roleId", "objective", "allowedScope", "forbiddenScope", "acceptanceRefs",
  "verificationPolicyRef", "requiredCapabilities", "expectedArtifacts",
  "callbackContract", "state",
]);

const agentSession = controlRecord("AgentSession", "sessionId", {
  agentId: ref("Id"),
  sessionLocator: ref("NonEmptyString"),
  adapter: strict({ id: ref("NonEmptyString"), version: ref("Semver") }),
  protocolVersion: { type: "string", pattern: "^pkr\\.dev/v[0-9]+\\.[0-9]+$" },
  capabilityStatementId: ref("Id"),
  assignmentIds: ref("IdList"),
  state: { enum: ["opening", "active", "suspended", "closing", "closed", "failed", "expired"] },
  lastHeartbeat: ref("Timestamp"),
  expiresAt: ref("Timestamp"),
});

const lease = controlRecord("Lease", "leaseId", {
  assignmentId: ref("Id"),
  sessionId: ref("Id"),
  agentId: ref("Id"),
  scope: arrayOf(ref("NonEmptyString"), 1),
  mode: { enum: ["exclusive", "shared"] },
  state: { enum: ["active", "renewed", "released", "revoked", "expired"] },
  acquiredAt: ref("Timestamp"),
  expiresAt: ref("Timestamp"),
  heartbeatIntervalSeconds: { type: "integer", minimum: 1 },
});

const agentMessage = strict({
  apiVersion: ref("ApiVersion"),
  kind: { const: "AgentMessage" },
  messageId: ref("Id"),
  projectId: ref("Id"),
  type: {
    enum: [
      "pkr.assignment.offer", "pkr.assignment.accept", "pkr.assignment.reject",
      "pkr.execution.started", "pkr.execution.progress", "pkr.execution.heartbeat",
      "pkr.execution.blocked", "pkr.execution.resumed", "pkr.execution.callback",
      "pkr.handoff.request", "pkr.handoff.accept", "pkr.handoff.complete",
      "pkr.assignment.cancel", "pkr.session.close", "pkr.lease.renew",
      "pkr.lease.release", "pkr.lease.revoke", "pkr.protocol.error",
    ],
  },
  sender: strict({ principalId: ref("Id"), sessionId: ref("Id") }),
  recipient: strict({ component: { enum: ["runtime", "steward", "orchestrator", "agent"] }, principalId: ref("Id") }, ["component"]),
  assignmentId: ref("Id"),
  leaseId: ref("Id"),
  correlationId: ref("Id"),
  causationId: ref("Id"),
  projectSequence: ref("Sequence"),
  issuedAt: ref("Timestamp"),
  payload: { type: "object" },
  extensions: ref("Extensions"),
}, [
  "apiVersion", "kind", "messageId", "projectId", "type", "sender",
  "recipient", "assignmentId", "correlationId", "projectSequence", "issuedAt",
  "payload", "extensions",
]);

const workspaceRequest = strict({
  apiVersion: ref("ApiVersion"),
  kind: { const: "WorkspaceRequest" },
  requestId: ref("Id"),
  projectId: ref("Id"),
  principal: ref("Actor"),
  roleId: ref("Id"),
  scope: ref("Scope"),
  profile: ref("NonEmptyString"),
  maxBytes: { type: "integer", minimum: 1024 },
  selector: strict({ projectSequence: ref("Sequence") }),
  requestedAt: ref("Timestamp"),
  extensions: ref("Extensions"),
});

const workspace = strict({
  apiVersion: ref("ApiVersion"),
  kind: { const: "Workspace" },
  workspaceId: ref("Id"),
  projectId: ref("Id"),
  principalId: ref("Id"),
  roleId: ref("Id"),
  projectSequence: ref("Sequence"),
  createdAt: ref("Timestamp"),
  expiresAt: ref("Timestamp"),
  context: strict({
    mission: ref("SourceRef"),
    goal: ref("SourceRef"),
    task: ref("SourceRef"),
    workflow: ref("SourceRef"),
    assignment: ref("SourceRef"),
    constraints: arrayOf(ref("SourceRef")),
    decisions: arrayOf(ref("SourceRef")),
    artifacts: arrayOf(ref("SourceRef")),
  }, ["mission", "goal", "task", "workflow", "assignment", "constraints", "decisions", "artifacts"]),
  permittedActions: ref("StringList"),
  forbiddenActions: ref("StringList"),
  memoryEntryIds: ref("IdList"),
  notices: arrayOf(strict({ type: { enum: ["truncated", "omitted", "redacted", "stale"] }, message: ref("NonEmptyString") })),
  extensions: ref("Extensions"),
});

const memoryEntry = strict({
  apiVersion: ref("ApiVersion"),
  kind: { const: "MemoryEntry" },
  memoryId: ref("Id"),
  projectId: ref("Id"),
  class: { enum: ["episodic", "semantic", "procedural", "working"] },
  summary: ref("NonEmptyString"),
  derived: { const: true },
  sourceRefs: arrayOf(ref("SourceRef"), 1),
  eventRanges: arrayOf(ref("EventRange")),
  derivation: strict({ method: ref("NonEmptyString"), version: ref("Semver") }),
  confidence: { type: "number", minimum: 0, maximum: 1 },
  retentionClass: { enum: ["session", "task", "project", "legalHold"] },
  visibility: ref("NonEmptyString"),
  projectSequence: ref("Sequence"),
  createdAt: ref("Timestamp"),
  validUntil: { oneOf: [ref("Timestamp"), { type: "null" }] },
  invalidatedAt: { oneOf: [ref("Timestamp"), { type: "null" }] },
  invalidationReason: { type: ["string", "null"] },
  extensions: ref("Extensions"),
});

const memoryProjection = strict({
  apiVersion: ref("ApiVersion"),
  kind: { const: "MemoryProjection" },
  projectionId: ref("Id"),
  projectId: ref("Id"),
  principalId: ref("Id"),
  projectSequence: ref("Sequence"),
  entryIds: ref("IdList"),
  visibilityProfile: ref("NonEmptyString"),
  status: { enum: ["current", "partial", "stale"] },
  createdAt: ref("Timestamp"),
  expiresAt: ref("Timestamp"),
  extensions: ref("Extensions"),
});

const dependency = strict({
  packageId: { type: "string", pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)+$" },
  versionRange: ref("NonEmptyString"),
  optional: { type: "boolean" },
});
const packageManifest = strict({
  apiVersion: ref("ApiVersion"),
  kind: { const: "PackageManifest" },
  manifestId: ref("Id"),
  packageId: { type: "string", pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)+$" },
  version: ref("Semver"),
  digest: ref("Digest"),
  publisher: strict({ principalId: ref("Id"), name: ref("NonEmptyString") }),
  compatibility: strict({ pkrApi: ref("NonEmptyString"), schema: ref("NonEmptyString") }),
  dependencies: arrayOf(dependency),
  conflicts: arrayOf(ref("NonEmptyString")),
  contributions: arrayOf(strict({ type: ref("NonEmptyString"), id: ref("NonEmptyString"), schemaId: { type: "string", format: "uri" } })),
  requestedCapabilities: ref("StringList"),
  lifecycle: strict({ install: ref("NonEmptyString"), migrate: ref("NonEmptyString"), uninstall: ref("NonEmptyString"), rollback: ref("NonEmptyString") }),
  license: ref("NonEmptyString"),
  distribution: { type: "string", format: "uri" },
  extensions: ref("Extensions"),
});

const packageInstallation = controlRecord("PackageInstallation", "installationId", {
  packageId: { type: "string", pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)+$" },
  version: ref("Semver"),
  digest: ref("Digest"),
  resolvedDependencies: arrayOf(strict({ packageId: ref("NonEmptyString"), version: ref("Semver"), digest: ref("Digest") })),
  approvedCapabilities: ref("StringList"),
  contributionIds: ref("StringList"),
  state: { enum: ["proposed", "resolving", "staged", "active", "suspended", "uninstalled", "failed", "superseded"] },
  installedBy: ref("Id"),
  decisionId: ref("Id"),
  workflowId: ref("Id"),
  workflowRevision: ref("Revision"),
  migrationStatus: { enum: ["notRequired", "pending", "passed", "failed"] },
  healthStatus: { enum: ["unknown", "healthy", "degraded", "failed"] },
  rollbackTarget: { type: ["string", "null"] },
});

const actionSpecs = {
  startWorkflowRun: ["WorkflowRun", true, { workflowId: ref("Id"), workflowRevision: ref("Revision"), scope: ref("Scope") }],
  transitionWorkflowRun: ["WorkflowRun", false, { toState: ref("NonEmptyString"), reason: ref("NonEmptyString") }],
  recordVerificationAttempt: ["WorkflowRun", false, { gate: { enum: ["build", "test", "security", "performance", "business", "acceptance"] }, result: { enum: ["passed", "failed", "waived", "cancelled"] }, evidenceRefs: arrayOf(ref("Id"), 1) }],
  offerAssignment: ["Assignment", true, { taskId: ref("Id"), taskRevision: ref("Revision"), workflowId: ref("Id"), workflowRevision: ref("Revision"), objective: ref("NonEmptyString") }],
  respondAssignment: ["Assignment", false, { response: { enum: ["accepted", "rejected"] } }],
  openAgentSession: ["AgentSession", true, { agentId: ref("Id"), capabilityStatementId: ref("Id"), sessionLocator: ref("NonEmptyString") }],
  closeAgentSession: ["AgentSession", false, { reason: ref("NonEmptyString") }],
  acquireLease: ["Lease", true, { assignmentId: ref("Id"), sessionId: ref("Id"), agentId: ref("Id"), mode: { enum: ["exclusive", "shared"] }, expiresAt: ref("Timestamp") }],
  renewLease: ["Lease", false, { expiresAt: ref("Timestamp") }],
  releaseLease: ["Lease", false, { reason: ref("NonEmptyString") }],
  revokeLease: ["Lease", false, { reason: ref("NonEmptyString") }],
  submitAgentMessage: ["AgentMessage", true, { messageId: ref("Id") }],
  proposePackageInstall: ["PackageInstallation", true, { packageId: ref("NonEmptyString"), version: ref("Semver"), digest: ref("Digest") }],
  resolvePackageInstall: ["PackageInstallation", false, { dependencies: arrayOf(ref("NonEmptyString")) }],
  stagePackageInstall: ["PackageInstallation", false, { migration: ref("NonEmptyString"), rollback: ref("NonEmptyString") }],
  activatePackageInstall: ["PackageInstallation", false, { verificationRefs: arrayOf(ref("Id"), 1) }],
  suspendPackageInstall: ["PackageInstallation", false, { reason: ref("NonEmptyString") }],
  uninstallPackage: ["PackageInstallation", false, { reason: ref("NonEmptyString") }],
  rollbackPackage: ["PackageInstallation", false, { targetVersion: ref("Semver"), targetDigest: ref("Digest") }],
};

function commandBranch(action, [targetKind, creates, payloadProperties]) {
  return strict({
    apiVersion: ref("ApiVersion"),
    kind: { const: "CoordinationCommand" },
    commandId: ref("Id"),
    projectId: ref("Id"),
    actor: ref("Actor"),
    roleId: ref("Id"),
    workflow: ref("WorkflowRef"),
    scope: ref("Scope"),
    action: { const: action },
    target: strict({ kind: { const: targetKind }, id: ref("Id") }),
    expectedRevision: creates ? { const: 0 } : ref("Revision"),
    decisionBasis: ref("DecisionBasis"),
    issuedAt: ref("Timestamp"),
    payload: strict(payloadProperties),
    extensions: ref("Extensions"),
  });
}

const commandDefs = Object.fromEntries(
  Object.entries(actionSpecs).map(([action, spec]) => [`Command_${action}`, commandBranch(action, spec)]),
);
const coordinationCommand = { oneOf: Object.keys(actionSpecs).map((action) => ref(`Command_${action}`)) };
const coordinationEvent = strict({
  apiVersion: ref("ApiVersion"),
  kind: { const: "CoordinationEvent" },
  eventId: ref("Id"),
  projectId: ref("Id"),
  sequence: { type: "integer", minimum: 1 },
  type: { type: "string", pattern: "^pkr\\.[a-zA-Z0-9.-]+$" },
  subject: strict({ kind: ref("NonEmptyString"), id: ref("Id") }),
  subjectRevision: ref("Revision"),
  commandId: ref("Id"),
  actor: ref("Actor"),
  roleId: ref("Id"),
  workflow: ref("WorkflowRef"),
  scope: ref("Scope"),
  decisionBasis: ref("DecisionBasis"),
  occurredAt: ref("Timestamp"),
  data: { type: "object" },
  extensions: ref("Extensions"),
});

const coordinationResult = {
  oneOf: [
    strict({
      apiVersion: ref("ApiVersion"), kind: { const: "CoordinationResult" },
      commandId: ref("Id"), projectId: ref("Id"), status: { const: "committed" },
      target: strict({ kind: ref("NonEmptyString"), id: ref("Id") }),
      targetRevision: ref("Revision"), eventRange: ref("EventRange"), errors: { const: [] },
      completedAt: ref("Timestamp"), extensions: ref("Extensions"),
    }),
    strict({
      apiVersion: ref("ApiVersion"), kind: { const: "CoordinationResult" },
      commandId: ref("Id"), projectId: ref("Id"), status: { enum: ["rejected", "conflict"] },
      target: strict({ kind: ref("NonEmptyString"), id: ref("Id") }),
      errors: arrayOf(strict({ code: { pattern: "^PKR-COORD-[0-9]{3}$" }, message: ref("NonEmptyString"), path: { type: "string" } }, ["code", "message"]), 1),
      completedAt: ref("Timestamp"), extensions: ref("Extensions"),
    }),
  ],
};

const definitions = {
  ...common,
  WorkflowRun: workflowRun,
  CapabilityStatement: capabilityStatement,
  Assignment: assignment,
  AgentSession: agentSession,
  Lease: lease,
  AgentMessage: agentMessage,
  WorkspaceRequest: workspaceRequest,
  Workspace: workspace,
  MemoryEntry: memoryEntry,
  MemoryProjection: memoryProjection,
  PackageManifest: packageManifest,
  PackageInstallation: packageInstallation,
  ...commandDefs,
  CoordinationCommand: coordinationCommand,
  CoordinationEvent: coordinationEvent,
  CoordinationResult: coordinationResult,
  WorkflowFamily: { oneOf: [ref("WorkflowRun")] },
  AgentFamily: { oneOf: [ref("CapabilityStatement"), ref("Assignment"), ref("AgentSession"), ref("Lease"), ref("AgentMessage")] },
  ContextFamily: { oneOf: [ref("WorkspaceRequest"), ref("Workspace"), ref("MemoryEntry"), ref("MemoryProjection")] },
  PackageFamily: { oneOf: [ref("PackageManifest"), ref("PackageInstallation")] },
  ProtocolFamily: { oneOf: [ref("CoordinationCommand"), ref("CoordinationEvent"), ref("CoordinationResult")] },
};

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: SCHEMA_ID,
  title: "PKR v0.4 Coordination Contract",
  oneOf: [ref("WorkflowFamily"), ref("AgentFamily"), ref("ContextFamily"), ref("PackageFamily"), ref("ProtocolFamily")],
  $defs: definitions,
};

const familySchemas = {
  "pkr-workflow.schema.json": "WorkflowFamily",
  "pkr-agent.schema.json": "AgentFamily",
  "pkr-context.schema.json": "ContextFamily",
  "pkr-package.schema.json": "PackageFamily",
  "pkr-coordination-runtime.schema.json": "ProtocolFamily",
};

const controlBase = (kind, idField, idValue, extra) => ({
  apiVersion: API_VERSION,
  kind,
  [idField]: idValue,
  projectId: "project_001",
  revision: 1,
  projectSequence: 20,
  createdAt: at,
  updatedAt: at,
  ...extra,
  extensions: {},
});

const records = [
  controlBase("WorkflowRun", "runId", "run_001", {
    workflowId: "workflow_001", workflowRevision: 2,
    scope: { type: "task", taskId: "task_001" }, state: "implementing",
    activeSteps: ["implement"], completedSteps: ["plan"], pendingGates: ["test"],
  }),
  {
    apiVersion: API_VERSION, kind: "CapabilityStatement",
    capabilityStatementId: "capability_001", projectId: "project_001", agentId: "agent_001",
    adapter: { id: "pkr.adapter.local-process", version: "0.4.0" },
    protocolVersions: [API_VERSION], capabilities: ["filesystem.read", "terminal"],
    limits: { maxConcurrency: 1, maxDurationSeconds: 3600 },
    isolation: { filesystem: "scoped", network: "none", credentials: "references-only" },
    issuedAt: at, expiresAt: later, extensions: {},
  },
  controlBase("Assignment", "assignmentId", "assignment_001", {
    idempotencyKey: "dispatch_001", taskId: "task_001", taskRevision: 3,
    workflowId: "workflow_001", workflowRevision: 2, roleId: "role_001",
    objective: "Implement the bounded reference lane.", allowedScope: ["src/**"], forbiddenScope: ["infra/**"],
    acceptanceRefs: ["task_001#acceptance-1"], verificationPolicyRef: "policy_default@1",
    requiredCapabilities: ["filesystem.read"], expectedArtifacts: ["source-change"],
    callbackContract: { outcomes: ["verified", "partial", "blocked", "externalSignoffBlocked"], evidenceRequired: true },
    state: "offered",
  }),
  controlBase("AgentSession", "sessionId", "session_001", {
    agentId: "agent_001", sessionLocator: "agent-native://session/001",
    adapter: { id: "pkr.adapter.local-process", version: "0.4.0" }, protocolVersion: API_VERSION,
    capabilityStatementId: "capability_001", assignmentIds: ["assignment_001"], state: "active",
    lastHeartbeat: at, expiresAt: later,
  }),
  controlBase("Lease", "leaseId", "lease_001", {
    assignmentId: "assignment_001", sessionId: "session_001", agentId: "agent_001",
    scope: ["src/**"], mode: "exclusive", state: "active", acquiredAt: at,
    expiresAt: later, heartbeatIntervalSeconds: 30,
  }),
  {
    apiVersion: API_VERSION, kind: "AgentMessage", messageId: "message_001",
    projectId: "project_001", type: "pkr.execution.callback",
    sender: { principalId: "agent_001", sessionId: "session_001" },
    recipient: { component: "orchestrator" }, assignmentId: "assignment_001",
    leaseId: "lease_001", correlationId: "dispatch_001", causationId: "message_000",
    projectSequence: 20, issuedAt: at, payload: { outcome: "verified" }, extensions: {},
  },
  {
    apiVersion: API_VERSION, kind: "WorkspaceRequest", requestId: "request_001",
    projectId: "project_001", principal: { principalType: "agent", principalId: "agent_001" },
    roleId: "role_001", scope: { type: "task", taskId: "task_001" }, profile: "execution",
    maxBytes: 65536, selector: { projectSequence: 20 }, requestedAt: at, extensions: {},
  },
  {
    apiVersion: API_VERSION, kind: "Workspace", workspaceId: "workspace_001",
    projectId: "project_001", principalId: "agent_001", roleId: "role_001", projectSequence: 20,
    createdAt: at, expiresAt: later,
    context: {
      mission: { kind: "Mission", id: "mission_001", revision: 1 },
      goal: { kind: "Goal", id: "goal_001", revision: 1 },
      task: { kind: "Task", id: "task_001", revision: 3 },
      workflow: { kind: "Workflow", id: "workflow_001", revision: 2 },
      assignment: { kind: "Assignment", id: "assignment_001", revision: 1 },
      constraints: [], decisions: [], artifacts: [],
    },
    permittedActions: ["submitAgentMessage"], forbiddenActions: ["updateManifest"],
    memoryEntryIds: ["memory_001"], notices: [], extensions: {},
  },
  {
    apiVersion: API_VERSION, kind: "MemoryEntry", memoryId: "memory_001", projectId: "project_001",
    class: "procedural", summary: "Run targeted tests before the full suite.", derived: true,
    sourceRefs: [{ kind: "Workflow", id: "workflow_001", revision: 2 }],
    eventRanges: [{ firstSequence: 10, lastSequence: 20 }],
    derivation: { method: "pkr.memory.summarize", version: "0.4.0" }, confidence: 0.9,
    retentionClass: "project", visibility: "role:developer", projectSequence: 20,
    createdAt: at, validUntil: null, invalidatedAt: null, invalidationReason: null, extensions: {},
  },
  {
    apiVersion: API_VERSION, kind: "MemoryProjection", projectionId: "projection_001",
    projectId: "project_001", principalId: "agent_001", projectSequence: 20,
    entryIds: ["memory_001"], visibilityProfile: "role:developer", status: "current",
    createdAt: at, expiresAt: later, extensions: {},
  },
  {
    apiVersion: API_VERSION, kind: "PackageManifest", manifestId: "manifest_001",
    packageId: "dev.pkr.web", version: "0.4.0",
    digest: `sha256:${"a".repeat(64)}`,
    publisher: { principalId: "human_001", name: "PKR" },
    compatibility: { pkrApi: ">=0.4 <1.0", schema: "pkr.dev/v0.4" },
    dependencies: [], conflicts: [],
    contributions: [{ type: "workflow", id: "dev.pkr.web/default", schemaId: "https://pkr.dev/packages/web/workflow.schema.json" }],
    requestedCapabilities: ["filesystem.read"],
    lifecycle: { install: "validate", migrate: "none", uninstall: "preserve-history", rollback: "previous" },
    license: "Apache-2.0", distribution: "https://pkr.dev/packages/web/0.4.0", extensions: {},
  },
  controlBase("PackageInstallation", "installationId", "installation_001", {
    packageId: "dev.pkr.web", version: "0.4.0", digest: `sha256:${"a".repeat(64)}`,
    resolvedDependencies: [], approvedCapabilities: ["filesystem.read"],
    contributionIds: ["dev.pkr.web/default"], state: "staged", installedBy: "human_001",
    decisionId: "decision_001", workflowId: "workflow_001", workflowRevision: 2,
    migrationStatus: "notRequired", healthStatus: "unknown", rollbackTarget: null,
  }),
];

const payloadExamples = {
  startWorkflowRun: { workflowId: "workflow_001", workflowRevision: 2, scope: { type: "task", taskId: "task_001" } },
  transitionWorkflowRun: { toState: "verifying", reason: "ImplementationComplete" },
  recordVerificationAttempt: { gate: "test", result: "passed", evidenceRefs: ["artifact_001"] },
  offerAssignment: { taskId: "task_001", taskRevision: 3, workflowId: "workflow_001", workflowRevision: 2, objective: "Execute the bounded lane." },
  respondAssignment: { response: "accepted" },
  openAgentSession: { agentId: "agent_001", capabilityStatementId: "capability_001", sessionLocator: "agent-native://session/001" },
  closeAgentSession: { reason: "AssignmentClosed" },
  acquireLease: { assignmentId: "assignment_001", sessionId: "session_001", agentId: "agent_001", mode: "exclusive", expiresAt: later },
  renewLease: { expiresAt: later },
  releaseLease: { reason: "CallbackSubmitted" },
  revokeLease: { reason: "CancelledByOwner" },
  submitAgentMessage: { messageId: "message_001" },
  proposePackageInstall: { packageId: "dev.pkr.web", version: "0.4.0", digest: `sha256:${"a".repeat(64)}` },
  resolvePackageInstall: { dependencies: [] },
  stagePackageInstall: { migration: "notRequired", rollback: "previous" },
  activatePackageInstall: { verificationRefs: ["verification_001"] },
  suspendPackageInstall: { reason: "HealthCheckFailed" },
  uninstallPackage: { reason: "OwnerRequested" },
  rollbackPackage: { targetVersion: "0.3.0", targetDigest: `sha256:${"b".repeat(64)}` },
};

const commandExamples = Object.entries(actionSpecs).map(([action, [targetKind, creates]]) => ({
  apiVersion: API_VERSION,
  kind: "CoordinationCommand",
  commandId: `command_${action}`,
  projectId: "project_001",
  actor: { principalType: "agent", principalId: "agent_steward" },
  roleId: "role_001",
  workflow: { id: "workflow_001", revision: 2 },
  scope: { type: "task", taskId: "task_001" },
  action,
  target: { kind: targetKind, id: `${targetKind.toLowerCase()}_001` },
  expectedRevision: creates ? 0 : 1,
  decisionBasis: { type: "operational", reason: "Execute the accepted bounded coordination step." },
  issuedAt: at,
  payload: payloadExamples[action],
  extensions: {},
}));

const eventExample = {
  apiVersion: API_VERSION, kind: "CoordinationEvent", eventId: "event_021",
  projectId: "project_001", sequence: 21, type: "pkr.assignment.offered",
  subject: { kind: "Assignment", id: "assignment_001" }, subjectRevision: 1,
  commandId: "command_offerAssignment", actor: { principalType: "agent", principalId: "agent_steward" },
  roleId: "role_001", workflow: { id: "workflow_001", revision: 2 },
  scope: { type: "task", taskId: "task_001" },
  decisionBasis: { type: "operational", reason: "Dispatch the accepted bounded lane." },
  occurredAt: at, data: { state: "offered" }, extensions: {},
};
const resultExample = {
  apiVersion: API_VERSION, kind: "CoordinationResult", commandId: "command_offerAssignment",
  projectId: "project_001", status: "committed",
  target: { kind: "Assignment", id: "assignment_001" }, targetRevision: 1,
  eventRange: { firstSequence: 21, lastSequence: 21 }, errors: [], completedAt: at, extensions: {},
};

const validCases = [
  ...records.map((instance) => ({ name: `valid-${instance.kind}`, instance })),
  ...commandExamples.map((instance) => ({ name: `valid-action-${instance.action}`, instance })),
  { name: "valid-CoordinationEvent", instance: eventExample },
  { name: "valid-CoordinationResult", instance: resultExample },
];
const invalidCases = [
  ...records.map((instance) => ({
    name: `invalid-${instance.kind}-unknown-field`,
    instance: { ...instance, unexpected: true },
  })),
  ...commandExamples.map((instance) => {
    const payload = { ...instance.payload };
    delete payload[Object.keys(payload)[0]];
    return {
      name: `invalid-action-${instance.action}-payload`,
      instance: { ...instance, payload },
    };
  }),
  {
    name: "invalid-event-type",
    instance: { ...eventExample, type: "assignment.offered" },
  },
  {
    name: "invalid-result-committed-with-error",
    instance: { ...resultExample, errors: [{ code: "PKR-COORD-011", message: "Commit failed." }] },
  },
];

const fixture = {
  schema: "../../schemas/v0.4/pkr-coordination.schema.json",
  resources: Object.keys(familySchemas).map((name) => `../../schemas/v0.4/${name}`),
  description: "PKR v0.4 coordination structural conformance cases.",
  validCases,
  invalidCases,
};

await mkdir(schemaDir, { recursive: true });
await mkdir(fixtureDir, { recursive: true });
await writeFile(join(schemaDir, "pkr-coordination.schema.json"), `${JSON.stringify(schema, null, 2)}\n`);
for (const [name, definition] of Object.entries(familySchemas)) {
  const family = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://pkr.dev/schemas/v0.4/${name}`,
    $ref: `${SCHEMA_ID}#/$defs/${definition}`,
  };
  await writeFile(join(schemaDir, name), `${JSON.stringify(family, null, 2)}\n`);
}
await writeFile(join(fixtureDir, "coordination-schema-cases.json"), `${JSON.stringify(fixture, null, 2)}\n`);

console.log(`Generated ${Object.keys(familySchemas).length + 1} schemas and ${validCases.length + invalidCases.length} fixtures.`);
