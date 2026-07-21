import { PkrError } from "./errors.js";
import {
  assessClarificationNeed,
  clarificationQuestionSheet,
  clarificationRunIdentity,
  ClarificationService,
  intentNeedsProtectedApproval,
  type ClarificationAssessment,
  type ClarificationAssessmentInput,
  type ClarificationState,
} from "./clarification.js";
import type { QuestionSheet, QuestionSheetResponse } from "./question-sheet.js";
import type { PkrRuntime } from "./runtime.js";
import type { JsonObject } from "./types.js";
import { derivedId, sha256 } from "./util.js";

export interface StewardClarification extends JsonObject {
  runId: string;
  contextDigest: string;
  state: ClarificationState;
  persisted: boolean;
  assessment: ClarificationAssessment;
}

export interface StewardProposal extends JsonObject {
  kind: "StewardProposal";
  proposalId: string;
  request: string;
  outcome: string;
  objective: string;
  material: boolean;
  affectedKinds: string[];
  requiredApproval: string | null;
  questionSheet: QuestionSheet | null;
  clarification: StewardClarification;
  state: "ready" | "awaitingApproval" | "awaitingClarification";
}

export interface StewardTaskCard extends JsonObject {
  apiVersion: "pkr.dev/v0.7";
  kind: "TaskCard";
  projectId: string;
  request: string;
  material: boolean;
  requiredApproval: string | null;
  approvedBy: string | null;
  decisionId: string | null;
  clarificationRunId: string;
  goalId: string;
  taskId: string;
  phase: string;
  next: {
    claim: "ready" | "blocked";
    submit: "after-claim" | "blocked";
    verify: "after-submit" | "blocked";
  };
}

export class StewardService {
  constructor(private readonly runtime: PkrRuntime) {}

  private clarificationInput(
    request: string,
    proposalId: string,
  ): ClarificationAssessmentInput {
    return {
      trigger: "steward-request",
      subject: { kind: "StewardProposal", id: proposalId, revision: 1 },
      intent: request,
      context: { requestDigest: `sha256:${sha256(request)}` },
    };
  }

  prepare(request: string): StewardProposal {
    const normalized = request.trim();
    if (!normalized) {
      throw new PkrError("PKR-STEWARD-001", "Steward request cannot be empty");
    }
    const material = intentNeedsProtectedApproval(normalized);
    const proposalId = `proposal_${sha256(normalized).slice(0, 32)}`;
    const affectedKinds = material
      ? ["Goal", "Task", "Decision", "Workflow"]
      : ["Goal", "Task"];
    const requiredApproval = material ? this.runtime.ownerId() : null;
    const clarificationInput = this.clarificationInput(normalized, proposalId);
    const assessment = assessClarificationNeed(clarificationInput);
    const questionSheet = clarificationQuestionSheet(clarificationInput, assessment);
    const identity = clarificationRunIdentity(clarificationInput, assessment);
    return {
      apiVersion: "pkr.dev/v0.6",
      kind: "StewardProposal",
      proposalId,
      request: normalized,
      outcome: normalized,
      objective: `Deliver the bounded outcome: ${normalized}`,
      material,
      affectedKinds,
      requiredApproval,
      questionSheet,
      clarification: {
        ...identity,
        state: assessment.blocking ? "blocked" : assessment.shouldAsk ? "awaiting-answers" : "no-question-needed",
        persisted: false,
        assessment,
      },
      state: material ? "awaitingApproval" : assessment.shouldAsk ? "awaitingClarification" : "ready",
      digest: `sha256:${sha256({ request: normalized, material, questionSheetDigest: questionSheet?.digest ?? null })}`,
    };
  }

  async prepareWithClarification(request: string): Promise<StewardProposal> {
    const proposal = this.prepare(request);
    const session = await new ClarificationService(this.runtime).assess(
      this.clarificationInput(proposal.request, proposal.proposalId),
    );
    return {
      ...proposal,
      clarification: {
        ...proposal.clarification,
        state: session.state,
        persisted: true,
      },
    };
  }

  async apply(
    proposal: StewardProposal,
    approvedBy?: string,
    clarificationResponse?: QuestionSheetResponse,
  ): Promise<JsonObject> {
    const ownerId = this.runtime.ownerId();
    const clarification = new ClarificationService(this.runtime);
    let session = await clarification.assess(
      this.clarificationInput(proposal.request, proposal.proposalId),
    );
    if (proposal.material && approvedBy !== ownerId) {
      throw new PkrError(
        "PKR-STEWARD-002",
        `material proposal requires explicit approval by ${ownerId}`,
      );
    }
    const actorId = approvedBy ?? ownerId;
    if (proposal.questionSheet) {
      const hasPlanningAmbiguity = proposal.questionSheet.questions.some((question) => question.materiality !== "protected");
      const response = clarificationResponse ?? (proposal.material && approvedBy === ownerId && !hasPlanningAmbiguity
        ? { action: "submit" as const, answers: { "protected-decision": "approve" } }
        : undefined);
      if (!response) {
        throw new PkrError(
          "PKR-STEWARD-003",
          `proposal requires clarification through run ${session.runId}`,
        );
      }
      const needsExplicitDirection = proposal.questionSheet.questions.some((question) => question.id === "decision-direction");
      if (
        needsExplicitDirection &&
        (response.action !== "submit" || !Object.hasOwn(response.answers, "decision-direction"))
      ) {
        throw new PkrError(
          "PKR-STEWARD-003",
          "ambiguous decision direction must be supplied explicitly before the proposal can proceed",
        );
      }
      if (session.state !== "resolved") {
        session = await clarification.respond(session.runId, response);
      }
      if (session.state !== "resolved" || !session.resolution) {
        throw new PkrError(
          "PKR-STEWARD-003",
          `clarification run ${session.runId} remains ${session.state}`,
        );
      }
      if (proposal.material) {
        const protectedAnswer = session.resolution.answers.find((answer) => answer.questionId === "protected-decision");
        if (protectedAnswer?.value !== "approve") {
          throw new PkrError("PKR-STEWARD-003", "protected proposal was not explicitly approved in its clarification response");
        }
      }
    }
    const clarifiedOutcome = session.resolution?.answers.find((answer) => answer.questionId === "goal-outcome")?.value;
    const decisionAnswer = session.resolution?.answers.find((answer) => answer.questionId === "decision-direction");
    if (decisionAnswer && decisionAnswer.source !== "human") {
      throw new PkrError(
        "PKR-STEWARD-003",
        "ambiguous decision direction remains deferred until the user supplies an explicit direction",
      );
    }
    const clarifiedDecision = decisionAnswer?.value;
    const outcome = typeof clarifiedOutcome === "string"
      ? clarifiedOutcome
      : typeof clarifiedDecision === "string" ? clarifiedDecision : proposal.outcome;
    let decisionId: string | null = null;
    if (proposal.material) {
      const decision = await this.runtime.createDecision(
        `Should the Project accept Steward proposal ${proposal.proposalId}?`,
        outcome,
        "The authenticated Project owner explicitly approved this material proposal.",
        proposal.affectedKinds,
        actorId,
        derivedId("command", `${proposal.proposalId}:decision`),
      );
      decisionId = ((decision.value as JsonObject).metadata as JsonObject).id as string;
    }
    const goal = await this.runtime.createGoal(
      outcome,
      actorId,
      derivedId("command", `${proposal.proposalId}:goal`),
    );
    const goalId = ((goal.value as JsonObject).metadata as JsonObject).id as string;
    const task = await this.runtime.createTask(
      goalId,
      `Deliver the bounded outcome: ${outcome}`,
      actorId,
      derivedId("command", `${proposal.proposalId}:task`),
    );
    const taskId = ((task.value as JsonObject).metadata as JsonObject).id as string;
    return {
      proposal,
      approvedBy: proposal.material ? actorId : null,
      decisionId,
      goalId,
      taskId,
      clarificationRunId: session.runId,
      projectSequence: this.runtime.status().projectSequence as number,
    };
  }

  taskCard(
    proposal: StewardProposal,
    result: JsonObject,
  ): StewardTaskCard {
    const goalId = result.goalId as string;
    const taskId = result.taskId as string;
    const task = this.runtime.getRecord("Task", taskId).data;
    const phase = (task.status as JsonObject).phase as string;
    const claimReady = phase === "backlog";
    return {
      apiVersion: "pkr.dev/v0.7",
      kind: "TaskCard",
      projectId: this.runtime.projectId,
      request: proposal.request,
      material: proposal.material,
      requiredApproval: proposal.requiredApproval,
      approvedBy: (result.approvedBy as string | null) ?? null,
      decisionId: (result.decisionId as string | null) ?? null,
      clarificationRunId: result.clarificationRunId as string,
      goalId,
      taskId,
      phase,
      next: {
        claim: claimReady ? "ready" : "blocked",
        submit: claimReady ? "after-claim" : "blocked",
        verify: claimReady ? "after-submit" : "blocked",
      },
    };
  }
}
