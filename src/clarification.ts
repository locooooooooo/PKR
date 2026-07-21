import { PkrError } from "./errors.js";
import {
  createQuestionSheet,
  resolveQuestionSheet,
  type QuestionMateriality,
  type QuestionOption,
  type QuestionSheet,
  type QuestionSheetQuestion,
  type QuestionSheetResolution,
  type QuestionSheetResponse,
  type QuestionType,
} from "./question-sheet.js";
import type { PkrRuntime } from "./runtime.js";
import type { JsonObject, JsonValue, StoredRecord } from "./types.js";
import { derivedId, digest } from "./util.js";
import type { PortableWorkflowDefinition } from "./workflow.js";

const EXTENSION = "pkr.clarification/v1";

export type ClarificationState =
  | "assessing"
  | "no-question-needed"
  | "question-drafted"
  | "awaiting-answers"
  | "blocked"
  | "resolved"
  | "cancelled"
  | "superseded";

export type AmbiguityDimension =
  | "goal"
  | "acceptance"
  | "scope"
  | "priority"
  | "decision"
  | "constraint"
  | "protected-action";

export interface ClarificationSubject extends JsonObject {
  kind: string;
  id: string;
  revision: number;
}

export interface AmbiguitySignal extends JsonObject {
  id: string;
  dimension: AmbiguityDimension;
  status: "clear" | "unknown" | "conflicting";
  prompt: string;
  questionType: QuestionType;
  materiality: QuestionMateriality;
  recommendation: JsonValue;
  recommendationReason: string;
  options: QuestionOption[];
  blockedActions: string[];
}

export interface ClarificationAssessmentInput {
  trigger: "steward-request" | "goal-review" | "decision-fork" | "execution-checkpoint";
  subject: ClarificationSubject;
  intent: string;
  context?: JsonObject;
  signals?: AmbiguitySignal[];
}

export interface ClarificationAssessment extends JsonObject {
  shouldAsk: boolean;
  blocking: boolean;
  priority: "none" | "normal" | "high";
  reasons: string[];
  signals: AmbiguitySignal[];
  blockedActions: string[];
  digest: string;
}

export interface ClarificationSession extends JsonObject {
  apiVersion: "pkr.clarification/v1";
  kind: "ClarificationSession";
  runId: string;
  state: ClarificationState;
  subject: ClarificationSubject;
  trigger: ClarificationAssessmentInput["trigger"];
  intent: string;
  contextDigest: string;
  assessment: ClarificationAssessment;
  questionSheet: QuestionSheet | null;
  resolution: QuestionSheetResolution | null;
  blockedActions: string[];
  supersededBy: string | null;
  revision: number;
  projectSequence: number;
}

export interface ClarificationIdentity {
  runId: string;
  contextDigest: string;
}

const PROTECTED_PATTERN =
  /(?:\b(?:architecture|architectural|security|secure|permission|permissions|authorization|authorisation|access control|public contract|api contract|compatibility|breaking change|budget|deadline|release|deploy|credential|credentials|secret|token|password|privacy|personal data|pii|compliance)\b|架构|体系结构|安全|加密|漏洞|攻击|权限|授权|访问控制|身份认证|公开接口|公共协议|对外接口|兼容|不兼容|破坏性变更|预算|截止日期|发布|上线|部署|生产环境|凭证|密钥|令牌|口令|密码|隐私|个人信息|敏感数据|合规)/iu;

const VAGUE_GOAL_PATTERN =
  /(?:\b(?:improve|optimize|polish|enhance|make it better|handle it|fix things|continue|as needed|somehow|appropriate|reasonable)\b|优化一下|优化|完善一下|完善|改进一下|改进|处理一下|处理|继续做|继续|做好一点|改一下|看情况|适当|合理一些)/iu;

const DECISION_FORK_PATTERN =
  /(?:\b(?:choose|decide|which|either|alternative|option|tradeoff|trade-off)\b|选择|决定|拍板|哪个方案|哪种方案|还是|取舍|备选)/iu;

export function intentNeedsProtectedApproval(intent: string): boolean {
  return PROTECTED_PATTERN.test(intent);
}

function automaticSignals(intent: string): AmbiguitySignal[] {
  const signals: AmbiguitySignal[] = [];
  if (VAGUE_GOAL_PATTERN.test(intent)) {
    signals.push({
      id: "goal-outcome",
      dimension: "goal",
      status: "unknown",
      prompt: "What concrete, observable outcome should replace this vague goal?",
      questionType: "blank",
      materiality: "planning",
      recommendation: `First inspect the current state and return a bounded improvement proposal for: ${intent}`,
      recommendationReason: "A reversible evidence-gathering step is safer than implementing against a vague goal.",
      options: [],
      blockedActions: [],
    });
  }
  if (DECISION_FORK_PATTERN.test(intent)) {
    signals.push({
      id: "decision-direction",
      dimension: "decision",
      status: "unknown",
      prompt: "Which decision or trade-off should PKR use as the governing direction?",
      questionType: "blank",
      materiality: "planning",
      recommendation: "Gather evidence for the viable options and defer implementation until one direction is selected.",
      recommendationReason: "The request names a fork but does not commit one direction.",
      options: [],
      blockedActions: [],
    });
  }
  if (intentNeedsProtectedApproval(intent)) {
    signals.push({
      id: "protected-decision",
      dimension: "protected-action",
      status: "unknown",
      prompt: "How should PKR handle this protected change?",
      questionType: "approval",
      materiality: "protected",
      recommendation: "defer",
      recommendationReason: "Deferring is the safe default until the Project owner reviews the material impact.",
      options: [
        { value: "approve", label: "Approve", impact: "Allows an authorized owner to continue." },
        { value: "revise", label: "Revise", impact: "Returns the proposal for a safer or clearer revision." },
        { value: "defer", label: "Decide later", impact: "Keeps the protected action blocked." },
      ],
      blockedActions: ["apply_steward_proposal"],
    });
  }
  return signals;
}

function validateSignals(signals: AmbiguitySignal[]): void {
  const ids = new Set<string>();
  for (const signal of signals) {
    if (!signal.id.trim() || ids.has(signal.id) || !signal.prompt.trim()) {
      throw new PkrError("PKR-CLARIFICATION-001", "Ambiguity signal ids and prompts must be non-empty and unique");
    }
    ids.add(signal.id);
    if (signal.materiality === "protected" && signal.blockedActions.length === 0) {
      throw new PkrError("PKR-CLARIFICATION-001", "Protected ambiguity signals must name blocked actions");
    }
  }
}

export function assessClarificationNeed(input: ClarificationAssessmentInput): ClarificationAssessment {
  const intent = input.intent.trim();
  if (!intent) {
    throw new PkrError("PKR-CLARIFICATION-001", "Clarification assessment intent cannot be empty");
  }
  const supplied = input.signals ?? [];
  const automatic = automaticSignals(intent);
  const byId = new Map<string, AmbiguitySignal>();
  for (const signal of [...automatic, ...supplied]) byId.set(signal.id, signal);
  const signals = [...byId.values()];
  validateSignals(signals);
  const unresolved = signals.filter((signal) => signal.status !== "clear");
  const blockingSignals = unresolved.filter((signal) => signal.materiality === "protected");
  const reasons = unresolved.map((signal) => `${signal.dimension}:${signal.status}`);
  const content = {
    shouldAsk: unresolved.length > 0,
    blocking: blockingSignals.length > 0,
    priority: blockingSignals.length > 0 ? "high" as const : unresolved.length > 0 ? "normal" as const : "none" as const,
    reasons,
    signals,
    blockedActions: [...new Set(blockingSignals.flatMap((signal) => signal.blockedActions))],
  };
  return { ...content, digest: digest(content) };
}

export function clarificationQuestionSheet(
  input: ClarificationAssessmentInput,
  assessment: ClarificationAssessment,
): QuestionSheet | null {
  if (!assessment.shouldAsk) return null;
  const questions: QuestionSheetQuestion[] = assessment.signals
    .filter((signal) => signal.status !== "clear")
    .map((signal) => ({
      id: signal.id,
      prompt: signal.prompt,
      type: signal.questionType,
      materiality: signal.materiality,
      required: false,
      recommendation: signal.recommendation,
      recommendationReason: signal.recommendationReason,
      skipBehavior: signal.materiality === "protected" ? "block_action" : "use_recommendation",
      blockedActions: signal.blockedActions,
      options: signal.options,
    }));
  return createQuestionSheet({
    title: assessment.blocking
      ? "PKR Critical Fork Decision Sheet"
      : input.trigger === "goal-review" ? "PKR Goal Clarification Sheet" : "PKR Proactive Clarification Sheet",
    trigger: "proactive_clarification",
    instructions: "Answer only what changes the recommendation. The sheet may be skipped, but protected actions stay blocked.",
    estimatedMinutes: Math.min(5, Math.max(1, questions.length)),
    questions,
  });
}

export function clarificationRunIdentity(
  input: ClarificationAssessmentInput,
  assessment = assessClarificationNeed(input),
): ClarificationIdentity {
  const contextDigest = digest({
    trigger: input.trigger,
    subject: input.subject,
    intent: input.intent.trim(),
    context: input.context ?? {},
    assessmentDigest: assessment.digest,
  });
  return {
    contextDigest,
    runId: derivedId("clarification", `${input.subject.kind}:${input.subject.id}:${input.subject.revision}:${contextDigest}`),
  };
}

const TRANSITION_PAIRS: Array<[ClarificationState, ClarificationState]> = [
  ["assessing", "no-question-needed"],
  ["assessing", "question-drafted"],
  ["assessing", "cancelled"],
  ["assessing", "superseded"],
  ["question-drafted", "awaiting-answers"],
  ["question-drafted", "blocked"],
  ["question-drafted", "cancelled"],
  ["question-drafted", "superseded"],
  ["awaiting-answers", "resolved"],
  ["awaiting-answers", "blocked"],
  ["awaiting-answers", "cancelled"],
  ["awaiting-answers", "superseded"],
  ["blocked", "blocked"],
  ["blocked", "resolved"],
  ["blocked", "awaiting-answers"],
  ["blocked", "cancelled"],
  ["blocked", "superseded"],
];

export const CLARIFICATION_WORKFLOW_DEFINITION: PortableWorkflowDefinition = {
  initial: "assessing",
  terminal: ["no-question-needed", "resolved", "cancelled", "superseded"],
  states: [
    "assessing",
    "no-question-needed",
    "question-drafted",
    "awaiting-answers",
    "blocked",
    "resolved",
    "cancelled",
    "superseded",
  ],
  transitions: TRANSITION_PAIRS.map(([from, to]) => ({
    name: `${from}-to-${to}`,
    from,
    to,
    when: { op: "eq", path: "authorized", value: true },
  })),
  verificationPolicy: [],
};

const TRANSITIONS = Object.fromEntries(
  CLARIFICATION_WORKFLOW_DEFINITION.states.map((state) => [
    state,
    TRANSITION_PAIRS.filter(([from]) => from === state).map(([, to]) => to),
  ]),
) as Record<ClarificationState, ClarificationState[]>;

function terminal(state: ClarificationState): boolean {
  return ["no-question-needed", "resolved", "cancelled", "superseded"].includes(state);
}

function extension(session: Omit<ClarificationSession, "revision" | "projectSequence"> | ClarificationSession): JsonObject {
  const { revision: _revision, projectSequence: _projectSequence, ...content } = session as ClarificationSession;
  return content as unknown as JsonObject;
}

function sessionFromRecord(record: StoredRecord): ClarificationSession {
  const value = (record.data.extensions as JsonObject | undefined)?.[EXTENSION];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PkrError("PKR-CLARIFICATION-002", `${record.id} has no clarification state`);
  }
  const content = value as unknown as Omit<ClarificationSession, "revision" | "projectSequence">;
  return {
    ...content,
    state: record.data.state as ClarificationState,
    revision: record.revision,
    projectSequence: record.data.projectSequence as number,
  } as ClarificationSession;
}

export class ClarificationService {
  constructor(private readonly runtime: PkrRuntime) {}

  list(): ClarificationSession[] {
    return this.runtime.listRecords("WorkflowRun")
      .filter((record) => (record.data.extensions as JsonObject | undefined)?.[EXTENSION] !== undefined)
      .map(sessionFromRecord);
  }

  get(runId: string): ClarificationSession {
    return sessionFromRecord(this.runtime.getRecord("WorkflowRun", runId));
  }

  async assess(input: ClarificationAssessmentInput): Promise<ClarificationSession> {
    const assessment = assessClarificationNeed(input);
    const { contextDigest, runId } = clarificationRunIdentity(input, assessment);
    const sheet = clarificationQuestionSheet(input, assessment);
    const base: Omit<ClarificationSession, "revision" | "projectSequence"> = {
      apiVersion: "pkr.clarification/v1",
      kind: "ClarificationSession",
      runId,
      state: "assessing",
      subject: input.subject,
      trigger: input.trigger,
      intent: input.intent.trim(),
      contextDigest,
      assessment,
      questionSheet: null,
      resolution: null,
      blockedActions: assessment.blockedActions,
      supersededBy: null,
    };
    let session = this.list().find((candidate) => candidate.runId === runId);
    if (session && session.state !== "assessing") return session;

    if (!session) {
      const prior = this.list().filter((candidate) =>
        candidate.subject.kind === input.subject.kind &&
        candidate.subject.id === input.subject.id &&
        !terminal(candidate.state)
      );
      for (const candidate of prior) {
        await this.transition(candidate, "superseded", {
          ...candidate,
          state: "superseded",
          supersededBy: runId,
        }, "newer clarification context replaced this run");
      }
      await this.runtime.startClarificationRun(
        runId,
        "assessing",
        extension(base),
        CLARIFICATION_WORKFLOW_DEFINITION as unknown as JsonObject,
        derivedId("command", `${runId}:start`),
      );
      session = this.get(runId);
    }
    if (!assessment.shouldAsk) {
      return this.transition(session, "no-question-needed", {
        ...base,
        state: "no-question-needed",
      }, "assessment found no unresolved ambiguity");
    }
    session = await this.transition(session, "question-drafted", {
      ...base,
      state: "question-drafted",
      questionSheet: sheet,
    }, "assessment produced a bounded question sheet");
    return this.transition(session, assessment.blocking ? "blocked" : "awaiting-answers", {
      ...base,
      state: assessment.blocking ? "blocked" : "awaiting-answers",
      questionSheet: sheet,
    }, assessment.blocking ? "protected ambiguity blocks the affected action" : "question sheet is awaiting optional answers");
  }

  async respond(runId: string, response: QuestionSheetResponse): Promise<ClarificationSession> {
    const session = this.get(runId);
    if (session.state !== "awaiting-answers" && session.state !== "blocked") {
      throw new PkrError("PKR-CLARIFICATION-003", `Clarification run ${runId} is not awaiting answers`);
    }
    if (!session.questionSheet) {
      throw new PkrError("PKR-CLARIFICATION-003", `Clarification run ${runId} has no question sheet`);
    }
    const resolution = resolveQuestionSheet(session.questionSheet, response);
    if (session.resolution?.digest === resolution.digest) return session;
    const next = resolution.state === "blocked" ? "blocked" : "resolved";
    return this.transition(session, next, {
      ...session,
      state: next,
      resolution,
      blockedActions: resolution.blockedActions,
    }, next === "resolved" ? "question sheet resolved" : "protected question was skipped");
  }

  private async transition(
    current: ClarificationSession,
    to: ClarificationState,
    changed: Omit<ClarificationSession, "revision" | "projectSequence">,
    reason: string,
  ): Promise<ClarificationSession> {
    if (!TRANSITIONS[current.state].includes(to)) {
      throw new PkrError("PKR-CLARIFICATION-003", `Illegal clarification transition ${current.state} -> ${to}`);
    }
    await this.runtime.transitionClarificationRun(
      current.runId,
      to,
      extension(changed),
      terminal(to),
      reason,
      derivedId("command", `${current.runId}:${current.revision}:${to}`),
    );
    return this.get(current.runId);
  }
}
