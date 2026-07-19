import type { JsonObject, JsonValue } from "./types.js";
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
    extensions: {},
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
}): JsonObject {
  return pomObject({
    kind: "Task",
    id: options.id,
    projectId: options.projectId,
    name: options.id.replace(/^task_/, "task-").slice(0, 63),
    title: options.objective.slice(0, 256),
    revision: 1,
    createdBy: options.createdBy,
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
  provider: string;
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
      provider: { vendor: options.provider },
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

export function knowledgeObject(options: {
  id: string;
  projectId: string;
  title: string;
  content: JsonValue;
  sourceUri: string;
  createdBy: string;
  knowledgeType?: "fact" | "capability" | "prompt" | "document";
}): JsonObject {
  return pomObject({
    kind: "Knowledge",
    id: options.id,
    projectId: options.projectId,
    name: options.id.replace(/^knowledge_/, "knowledge-").slice(0, 63),
    title: options.title.slice(0, 256),
    revision: 1,
    createdBy: options.createdBy,
    spec: {
      knowledgeType: options.knowledgeType ?? "fact",
      content: options.content,
      sources: [{ uri: options.sourceUri, observedAt: now() }],
      owners: [accountableOwner(options.createdBy)],
    },
    status: {
      phase: "active",
      reason: "KnowledgeActivated",
    },
  });
}

export function profileWorkflowObject(options: {
  id: string;
  projectId: string;
  name: string;
  title: string;
  definition: JsonObject;
  createdBy: string;
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
      appliesTo: ["Task"],
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
