import type { JsonObject, JsonValue, MetricThreshold } from "./types.js";
import { now } from "./util.js";

export const CORE_KINDS = [
  "Mission",
  "Goal",
  "Task",
  "Knowledge",
  "Decision",
  "Constraint",
  "Workflow",
  "Verification",
  "Artifact",
  "Metric",
  "Agent",
  "Role",
  "Issue",
  "Release",
] as const;

export function accountableOwner(principalId: string): JsonObject {
  return {
    principalType: principalId.startsWith("agent_") ? "agent" : "human",
    principalId,
    accountability: "accountable",
  };
}

export function pomObject(options: {
  kind: string;
  id: string;
  projectId: string;
  name: string;
  title: string;
  revision: number;
  createdBy: string;
  spec: JsonObject;
  status: JsonObject;
  relations?: JsonValue[];
  extensions?: JsonObject;
  createdAt?: string;
}): JsonObject {
  const timestamp = options.createdAt ?? now();
  return {
    apiVersion: "pkr.dev/v0.2",
    kind: options.kind,
    metadata: {
      id: options.id,
      projectId: options.projectId,
      name: options.name,
      title: options.title,
      revision: options.revision,
      createdAt: timestamp,
      createdBy: options.createdBy,
      updatedAt: timestamp,
      labels: {},
    },
    spec: options.spec,
    status: {
      ...options.status,
      observedRevision: options.revision,
    },
    relations: options.relations ?? [],
    extensions: options.extensions ?? {},
  };
}

export function missionObject(options: {
  id: string;
  projectId: string;
  outcome: string;
  createdBy: string;
  revision?: number;
  phase?: "draft" | "active";
}): JsonObject {
  const revision = options.revision ?? 1;
  return pomObject({
    kind: "Mission",
    id: options.id,
    projectId: options.projectId,
    name: "project-mission",
    title: "Project Mission",
    revision,
    createdBy: options.createdBy,
    spec: {
      outcome: options.outcome,
      successCriteria: [
        {
          id: "runtime-proven",
          statement: "The project outcome is proven by governed verification.",
          required: true,
        },
      ],
      budget: {
        mode: "notSet",
        reason: "Budget is not committed during local initialization.",
      },
      deadline: {
        mode: "none",
        reason: "No deadline is committed during local initialization.",
      },
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase: options.phase ?? "draft",
      reason: options.phase === "active" ? "MissionActivated" : "MissionCreated",
    },
  });
}

export function ownerRoleObject(options: {
  id: string;
  projectId: string;
  createdBy: string;
  revision?: number;
  phase?: "draft" | "active";
}): JsonObject {
  const revision = options.revision ?? 1;
  return pomObject({
    kind: "Role",
    id: options.id,
    projectId: options.projectId,
    name: "owner",
    title: "Project Owner",
    revision,
    createdBy: options.createdBy,
    spec: {
      responsibilities: [
        "Own project governance and authorize changes to project policy.",
      ],
      permissions: [
        {
          action: "pkr/governance",
          effect: "allow",
          scope: { kinds: [...CORE_KINDS] },
        },
      ],
      separationRules: [],
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase: options.phase ?? "draft",
      reason: options.phase === "active" ? "RoleActivated" : "RoleCreated",
    },
  });
}

export function governanceWorkflowObject(options: {
  id: string;
  projectId: string;
  createdBy: string;
  revision?: number;
  phase?: "draft" | "active";
}): JsonObject {
  const revision = options.revision ?? 1;
  return pomObject({
    kind: "Workflow",
    id: options.id,
    projectId: options.projectId,
    name: "governance",
    title: "Project Governance",
    revision,
    createdBy: options.createdBy,
    spec: {
      appliesTo: [...CORE_KINDS],
      steps: [
        {
          id: "govern",
          title: "Execute an authorized governance change",
          action: "governance/execute",
          allowedRoleNames: ["owner"],
          entryConditionRefs: ["governance/authorized"],
          exitConditionRefs: ["governance/recorded"],
        },
      ],
      transitions: [],
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase: options.phase ?? "draft",
      reason:
        options.phase === "active" ? "WorkflowActivated" : "WorkflowCreated",
    },
  });
}

export function goalObject(options: {
  id: string;
  projectId: string;
  missionId: string;
  outcome: string;
  createdBy: string;
}): JsonObject {
  return pomObject({
    kind: "Goal",
    id: options.id,
    projectId: options.projectId,
    name: options.id.replace(/^goal_/, "goal-").slice(0, 63),
    title: options.outcome.slice(0, 256),
    revision: 1,
    createdBy: options.createdBy,
    spec: {
      outcome: options.outcome,
      measures: [
        {
          id: "goal-complete",
          statement: "All required Tasks and Goal verification are complete.",
          operator: "eq",
          target: true,
        },
      ],
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase: "proposed",
      reason: "GoalCreated",
      measureResults: [],
    },
    relations: [
      {
        type: "contributesTo",
        target: { kind: "Mission", id: options.missionId },
        required: true,
      },
    ],
  });
}

export function taskObject(options: {
  id: string;
  projectId: string;
  goalId: string;
  workflowId: string;
  objective: string;
  createdBy: string;
  extensions?: JsonObject;
}): JsonObject {
  return pomObject({
    kind: "Task",
    id: options.id,
    projectId: options.projectId,
    name: options.id.replace(/^task_/, "task-").slice(0, 63),
    title: options.objective.slice(0, 256),
    revision: 1,
    createdBy: options.createdBy,
    ...(options.extensions ? { extensions: options.extensions } : {}),
    spec: {
      objective: options.objective,
      acceptance: [
        {
          id: "task-accepted",
          statement: "The bounded deliverable and its evidence are accepted.",
          required: true,
        },
      ],
      verificationPolicy: [
        { gate: "test", required: true, allowWaiver: false },
        { gate: "acceptance", required: true, allowWaiver: false },
      ],
      deliverables: [
        { id: "task-artifact", artifactType: "pkr/source-change", required: true },
      ],
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase: "backlog",
      reason: "TaskCreated",
      acceptanceResults: [],
    },
    relations: [
      {
        type: "contributesTo",
        target: { kind: "Goal", id: options.goalId },
        required: true,
      },
      {
        type: "governedBy",
        target: { kind: "Workflow", id: options.workflowId },
        required: true,
      },
    ],
  });
}

export function agentObject(options: {
  id: string;
  projectId: string;
  name: string;
  host: string;
  createdBy: string;
  revision?: number;
  phase?: "registered" | "active";
}): JsonObject {
  const revision = options.revision ?? 1;
  return pomObject({
    kind: "Agent",
    id: options.id,
    projectId: options.projectId,
    name: options.name,
    title: `${options.name} Agent`,
    revision,
    createdBy: options.createdBy,
    spec: {
      provider: { vendor: options.host },
      capabilities: ["filesystem/read", "filesystem/write", "terminal/execute"],
      permissions: [
        {
          action: "pkr/execute",
          effect: "allow",
          scope: { kinds: ["Task", "Artifact", "Verification"] },
        },
      ],
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase: options.phase ?? "registered",
      reason: options.phase === "active" ? "AgentActivated" : "AgentRegistered",
      ...(options.phase === "active" ? { lastSeenAt: now() } : {}),
    },
  });
}

export function decisionObject(options: {
  id: string;
  projectId: string;
  question: string;
  choice: string;
  reason: string;
  affectedKinds: string[];
  createdBy: string;
  revision?: number;
  phase?: "proposed" | "accepted";
  extensions?: JsonObject;
}): JsonObject {
  const revision = options.revision ?? 1;
  return pomObject({
    kind: "Decision",
    id: options.id,
    projectId: options.projectId,
    name: options.id.replace(/^decision_/, "decision-").slice(0, 63),
    title: options.question.slice(0, 256),
    revision,
    createdBy: options.createdBy,
    ...(options.extensions ? { extensions: options.extensions } : {}),
    spec: {
      question: options.question,
      choice: options.choice,
      reasons: [options.reason],
      alternatives: [],
      alternativeOmissionReason: "This local Steward proposal has one explicit bounded choice.",
      scope: { kinds: options.affectedKinds },
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase: options.phase ?? "proposed",
      reason: options.phase === "accepted" ? "DecisionAccepted" : "DecisionProposed",
    },
  });
}

export function constraintObject(options: {
  id: string;
  projectId: string;
  title: string;
  rule: string;
  scopeKinds: string[];
  severity: "error" | "critical";
  enforcement: "blocking";
  createdBy: string;
  revision?: number;
  phase?: "active" | "retired";
  relations?: JsonValue[];
}): JsonObject {
  const revision = options.revision ?? 1;
  const phase = options.phase ?? "active";
  return pomObject({
    kind: "Constraint",
    id: options.id,
    projectId: options.projectId,
    name: options.id.replace(/^constraint_/, "constraint-").slice(0, 63),
    title: options.title.slice(0, 256),
    revision,
    createdBy: options.createdBy,
    spec: {
      rule: options.rule,
      scope: { kinds: options.scopeKinds },
      severity: options.severity,
      enforcement: options.enforcement,
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase,
      reason: phase === "active" ? "PolicyActivated" : "PolicyRetired",
    },
    ...(options.relations ? { relations: options.relations } : {}),
  });
}

export function knowledgeObject(options: {
  id: string;
  projectId: string;
  title: string;
  content: JsonValue;
  sourceUri: string;
  createdBy: string;
  knowledgeType?: "fact" | "capability" | "prompt" | "document";
  revision?: number;
  phase?: "draft" | "active" | "deprecated";
  relations?: JsonValue[];
  sourceDigest?: string;
}): JsonObject {
  const revision = options.revision ?? 1;
  const phase = options.phase ?? "active";
  return pomObject({
    kind: "Knowledge",
    id: options.id,
    projectId: options.projectId,
    name: options.id.replace(/^knowledge_/, "knowledge-").slice(0, 63),
    title: options.title.slice(0, 256),
    revision,
    createdBy: options.createdBy,
    spec: {
      knowledgeType: options.knowledgeType ?? "fact",
      content: options.content,
      sources: [{
        uri: options.sourceUri,
        ...(options.sourceDigest ? { digest: options.sourceDigest } : {}),
        observedAt: now(),
      }],
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase,
      reason: phase === "draft"
        ? "KnowledgeDrafted"
        : phase === "deprecated" ? "KnowledgeDeprecated" : "KnowledgeActivated",
    },
    ...(options.relations ? { relations: options.relations } : {}),
  });
}

export function metricObject(options: {
  id: string;
  projectId: string;
  measure: string;
  sourceAdapter: string;
  sourceConfiguration: JsonObject;
  window: string;
  threshold: MetricThreshold;
  value: string | number | boolean;
  thresholdSatisfied: boolean;
  createdBy: string;
}): JsonObject {
  const timestamp = now();
  const metric = pomObject({
    kind: "Metric",
    id: options.id,
    projectId: options.projectId,
    name: options.id.replace(/^metric_/, "metric-").slice(0, 63),
    title: options.measure.slice(0, 256),
    revision: 1,
    createdBy: options.createdBy,
    createdAt: timestamp,
    spec: {
      measure: options.measure,
      source: {
        adapter: options.sourceAdapter,
        configuration: options.sourceConfiguration,
      },
      window: options.window,
      thresholds: [options.threshold as unknown as JsonObject],
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase: options.thresholdSatisfied ? "healthy" : "breached",
      reason: options.thresholdSatisfied ? "MetricHealthy" : "MetricThresholdBreached",
      lastValue: options.value,
      observedAt: timestamp,
    },
  });
  return {
    ...metric,
    extensions: {
      "pkr.metric/evaluation": {
        thresholdSatisfied: options.thresholdSatisfied,
        threshold: options.threshold as unknown as JsonObject,
      },
    },
  };
}

export function issueObject(options: {
  id: string;
  projectId: string;
  summary: string;
  impact: string;
  observations: JsonValue[];
  createdBy: string;
  issueType?: "defect" | "risk" | "question" | "feedback";
  severity?: "info" | "warning" | "error" | "critical";
  reason?: string;
  observationRule?: string;
}): JsonObject {
  const issue = pomObject({
    kind: "Issue",
    id: options.id,
    projectId: options.projectId,
    name: options.id.replace(/^issue_/, "issue-").slice(0, 63),
    title: options.summary.slice(0, 256),
    revision: 1,
    createdBy: options.createdBy,
    spec: {
      issueType: options.issueType ?? "risk",
      summary: options.summary,
      severity: options.severity ?? "warning",
      impact: options.impact,
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase: "open",
      reason: options.reason ?? "RepeatedFailures",
    },
  });
  return {
    ...issue,
    extensions: {
      "pkr.evolution/observations": options.observations,
      ...(options.observationRule
        ? { "pkr.evolution/observation-rule": options.observationRule }
        : {}),
    },
  };
}

export function evolutionCandidateObject(options: {
  id: string;
  projectId: string;
  issueId: string;
  content: JsonObject;
  contentDigest: string;
  targetKind: string;
  targetId: string;
  activeVersion: string;
  proposerId: string;
  permissionDelta: JsonObject;
  createdBy: string;
  supersedesId?: string;
}): JsonObject {
  const candidate = pomObject({
    kind: "Artifact",
    id: options.id,
    projectId: options.projectId,
    name: options.id.replace(/^candidate_/, "candidate-").slice(0, 63),
    title: `${options.targetKind} improvement candidate`,
    revision: 1,
    createdBy: options.createdBy,
    spec: {
      artifactType: "pkr/evolution-candidate",
      locator: `.pkr/candidates/${options.id}.json`,
      digest: options.contentDigest,
      provenance: {
        declaredBy: options.proposerId,
        generation: {
          actorId: options.proposerId,
          commandId: options.id,
          generatedAt: now(),
        },
        sourceDigests: [],
      },
      owners: [accountableOwner(options.createdBy)],
    },
    status: { phase: "available", reason: "CandidateProposed" },
    relations: [
      {
        type: "derivedFrom",
        target: { kind: "Issue", id: options.issueId },
        required: true,
      },
      ...(options.supersedesId
        ? [{
            type: "supersedes",
            target: { kind: "Artifact", id: options.supersedesId },
            required: true,
          }]
        : []),
    ],
  });
  return {
    ...candidate,
    extensions: {
      "pkr.evolution/candidate": {
        content: options.content,
        contentDigest: options.contentDigest,
        targetKind: options.targetKind,
        targetId: options.targetId,
        activeVersion: options.activeVersion,
        proposerId: options.proposerId,
        permissionDelta: options.permissionDelta,
        state: "inactive",
      },
    },
  };
}

export function adapterVersionObject(options: {
  id: string;
  projectId: string;
  title: string;
  contentDigest: string;
  implementationDigest: string;
  createdBy: string;
  commandId: string;
  revision?: number;
  phase?: "available" | "archived";
  relations?: JsonValue[];
}): JsonObject {
  const revision = options.revision ?? 1;
  const phase = options.phase ?? "available";
  return pomObject({
    kind: "Artifact",
    id: options.id,
    projectId: options.projectId,
    name: options.id.replace(/^adapter_/, "adapter-").slice(0, 63),
    title: options.title.slice(0, 256),
    revision,
    createdBy: options.createdBy,
    spec: {
      artifactType: "pkr/adapter-version",
      locator: `.pkr/adapters/${options.id}.json`,
      digest: options.contentDigest,
      provenance: {
        declaredBy: options.createdBy,
        generation: {
          actorId: options.createdBy,
          commandId: options.commandId,
          generatedAt: now(),
        },
        sourceDigests: [options.implementationDigest],
      },
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase,
      reason: phase === "available" ? "AdapterActivated" : "AdapterRetired",
    },
    ...(options.relations ? { relations: options.relations } : {}),
  });
}

export function evolutionEvaluationArtifactObject(options: {
  id: string;
  projectId: string;
  candidateId: string;
  candidateDigest: string;
  result: JsonObject;
  createdBy: string;
}): JsonObject {
  const artifact = pomObject({
    kind: "Artifact",
    id: options.id,
    projectId: options.projectId,
    name: options.id.replace(/^evaluation_/, "evaluation-").slice(0, 63),
    title: "Evolution canary evaluation",
    revision: 1,
    createdBy: options.createdBy,
    spec: {
      artifactType: "pkr/evolution-evaluation",
      locator: `.pkr/evaluations/${options.id}.json`,
      digest: options.result.digest as string,
      provenance: {
        declaredBy: options.createdBy,
        generation: {
          actorId: options.createdBy,
          commandId: options.id,
          generatedAt: now(),
        },
        sourceDigests: [options.candidateDigest],
      },
      owners: [accountableOwner(options.createdBy)],
    },
    status: { phase: "available", reason: "CanaryRecorded" },
    relations: [{
      type: "derivedFrom",
      target: { kind: "Artifact", id: options.candidateId },
      required: true,
    }],
  });
  return {
    ...artifact,
    extensions: { "pkr.evolution/canary": options.result },
  };
}

export function evolutionVerificationObject(options: {
  id: string;
  projectId: string;
  candidateId: string;
  candidateDigest: string;
  evaluationId: string;
  passed: boolean;
  createdBy: string;
  methodAdapter?: string;
  methodVersion?: string;
}): JsonObject {
  const timestamp = now();
  const verification = pomObject({
    kind: "Verification",
    id: options.id,
    projectId: options.projectId,
    name: options.id.replace(/^verification_/, "verification-").slice(0, 63),
    title: "Evolution candidate canary",
    revision: 1,
    createdBy: options.createdBy,
    spec: {
      gate: "pkr/canary",
      method: {
        adapter: options.methodAdapter ?? "pkr/canary",
        version: options.methodVersion ?? "0.8.0",
        parameters: { candidateDigest: options.candidateDigest },
      },
      requiredEvidence: ["pkr/evolution-evaluation"],
      waivable: false,
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase: options.passed ? "passed" : "failed",
      reason: options.passed ? "CanaryPassed" : "CanaryFailed",
      attempt: 1,
      targetRevision: 1,
      startedAt: timestamp,
      completedAt: timestamp,
      executor: {
        principalType: options.createdBy.startsWith("agent_") ? "agent" : "human",
        principalId: options.createdBy,
      },
    },
    relations: [
      {
        type: "verifies",
        target: { kind: "Artifact", id: options.candidateId },
        required: true,
      },
      {
        type: "produces",
        target: { kind: "Artifact", id: options.evaluationId },
        required: true,
      },
    ],
  });
  return {
    ...verification,
    extensions: {
      "pkr.evolution/candidate": {
        candidateId: options.candidateId,
        candidateDigest: options.candidateDigest,
      },
    },
  };
}

export function profileWorkflowObject(options: {
  id: string;
  projectId: string;
  name: string;
  title: string;
  definition: JsonObject;
  createdBy: string;
  appliesTo?: string[];
  revision?: number;
  phase?: "draft" | "active";
}): JsonObject {
  const transitions = (options.definition.transitions as JsonValue[]).map(
    (transition) => {
      const value = transition as JsonObject;
      return {
        from: value.from as string,
        to: value.to as string,
        on: `${options.name}/${value.name as string}`,
        requiredGates: [],
      };
    },
  );
  const steps = (options.definition.states as JsonValue[]).map((state) => ({
    id: state as string,
    title: `${state as string} step`,
    action: `${options.name}/${state as string}`,
    allowedRoleNames: ["owner"],
    entryConditionRefs: [`${options.name}/authorized`],
    exitConditionRefs: [`${options.name}/recorded`],
  }));
  const workflow = pomObject({
    kind: "Workflow",
    id: options.id,
    projectId: options.projectId,
    name: options.name,
    title: options.title,
    revision: options.revision ?? 2,
    createdBy: options.createdBy,
    spec: {
      appliesTo: options.appliesTo ?? ["Task"],
      steps,
      transitions,
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase: options.phase ?? "active",
      reason: options.phase === "draft" ? "WorkflowCreated" : "WorkflowActivated",
    },
    relations: [],
    createdAt: now(),
  });
  return {
    ...workflow,
    extensions: {
      "pkr.workflow/definition": options.definition,
    },
  };
}

export function artifactObject(options: {
  id: string;
  projectId: string;
  taskId: string;
  digest: string;
  commandId: string;
  createdBy: string;
}): JsonObject {
  return pomObject({
    kind: "Artifact",
    id: options.id,
    projectId: options.projectId,
    name: options.id.replace(/^artifact_/, "artifact-").slice(0, 63),
    title: "Task delivery evidence",
    revision: 1,
    createdBy: options.createdBy,
    spec: {
      artifactType: "pkr/source-change",
      locator: `.pkr/artifacts/${options.id}.json`,
      digest: options.digest,
      provenance: {
        declaredBy: options.createdBy,
        generation: {
          actorId: options.createdBy,
          commandId: options.commandId,
          generatedAt: now(),
        },
        sourceDigests: [],
      },
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase: "available",
      reason: "ArtifactAvailable",
    },
    relations: [],
  });
}

export function repositoryVerificationArtifactObject(options: {
  id: string;
  projectId: string;
  taskId: string;
  digest: string;
  commandId: string;
  createdBy: string;
}): JsonObject {
  return pomObject({
    kind: "Artifact",
    id: options.id,
    projectId: options.projectId,
    name: options.id.replace(/^artifact_/, "artifact-").slice(0, 63),
    title: "Repository verification evidence",
    revision: 1,
    createdBy: options.createdBy,
    spec: {
      artifactType: "pkr/repository-verification",
      locator: `.pkr/verifications/${options.id}.json`,
      digest: options.digest,
      provenance: {
        declaredBy: options.createdBy,
        generation: {
          actorId: options.createdBy,
          commandId: options.commandId,
          generatedAt: now(),
        },
        sourceDigests: [],
      },
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase: "available",
      reason: "VerificationEvidenceAvailable",
    },
    relations: [{
      type: "verifies",
      target: { kind: "Task", id: options.taskId },
      required: true,
    }],
  });
}

export function verificationObject(options: {
  id: string;
  projectId: string;
  taskId: string;
  taskRevision: number;
  artifactId: string;
  createdBy: string;
  gate: "test" | "acceptance";
  passed?: boolean;
  methodAdapter?: string;
  methodVersion?: string;
  evidenceType?: string;
  evidenceDigest?: string;
}): JsonObject {
  const timestamp = now();
  const passed = options.passed ?? true;
  return pomObject({
    kind: "Verification",
    id: options.id,
    projectId: options.projectId,
    name: options.id.replace(/^verification_/, "verification-").slice(0, 63),
    title: `${options.gate} verification`,
    revision: 1,
    createdBy: options.createdBy,
    spec: {
      gate: options.gate,
      method: {
        adapter: options.methodAdapter ?? "pkr/local",
        version: options.methodVersion ?? "0.5.0",
        parameters: options.evidenceDigest
          ? { evidenceDigest: options.evidenceDigest }
          : {},
      },
      requiredEvidence: [options.evidenceType ?? "pkr/artifact"],
      waivable: false,
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase: passed ? "passed" : "failed",
      reason: passed ? "VerificationPassed" : "VerificationFailed",
      attempt: 1,
      targetRevision: options.taskRevision,
      startedAt: timestamp,
      completedAt: timestamp,
      executor: {
        principalType: options.createdBy.startsWith("agent_") ? "agent" : "human",
        principalId: options.createdBy,
      },
    },
    relations: [
      {
        type: "verifies",
        target: { kind: "Task", id: options.taskId },
        required: true,
      },
      {
        type: "produces",
        target: { kind: "Artifact", id: options.artifactId },
        required: true,
      },
    ],
  });
}

export function revisePom(
  object: JsonObject,
  revision: number,
  status: JsonObject,
): JsonObject {
  return {
    ...object,
    metadata: {
      ...(object.metadata as JsonObject),
      revision,
      updatedAt: now(),
    },
    status: {
      ...status,
      observedRevision: revision,
    },
  };
}

export function reviseControl(
  record: JsonObject,
  revision: number,
  projectSequence: number,
  changes: JsonObject,
): JsonObject {
  return {
    ...record,
    ...changes,
    revision,
    projectSequence,
    updatedAt: now(),
  };
}
