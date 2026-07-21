import { PkrError } from "./errors.js";
import type { JsonObject, JsonPrimitive, JsonValue } from "./types.js";
import { derivedId, digest } from "./util.js";

export type QuestionType = "single_choice" | "multiple_choice" | "blank" | "approval";
export type QuestionMateriality = "preference" | "planning" | "protected";
export type QuestionSkipBehavior = "use_recommendation" | "leave_unresolved" | "block_action";
export type QuestionSheetTrigger = "project_intake" | "critical_fork" | "proactive_clarification";
export type QuestionSheetAction = "submit" | "accept_recommended" | "skip";

export interface QuestionOption extends JsonObject {
  value: JsonPrimitive;
  label: string;
  impact: string;
}

export interface QuestionSheetQuestion extends JsonObject {
  id: string;
  prompt: string;
  type: QuestionType;
  materiality: QuestionMateriality;
  required: false;
  recommendation: JsonValue;
  recommendationReason: string;
  skipBehavior: QuestionSkipBehavior;
  blockedActions: string[];
  options: QuestionOption[];
}

export interface QuestionSheet extends JsonObject {
  apiVersion: "pkr.question-sheet/v1";
  kind: "QuestionSheet";
  sheetId: string;
  title: string;
  trigger: QuestionSheetTrigger;
  instructions: string;
  estimatedMinutes: number;
  behavior: {
    sheetSkippable: true;
    recommendationsPreselected: true;
    triggerPolicy: "critical_forks_only";
    protectedSkipPolicy: "block_action";
  };
  questions: QuestionSheetQuestion[];
  state: "awaiting_answers";
  digest: string;
}

export interface QuestionSheetResponse extends JsonObject {
  action: QuestionSheetAction;
  answers: JsonObject;
}

export interface ResolvedQuestionAnswer extends JsonObject {
  questionId: string;
  value: JsonValue;
  source: "human" | "recommendation" | "unresolved";
}

export interface QuestionSheetResolution extends JsonObject {
  apiVersion: "pkr.question-sheet/v1";
  kind: "QuestionSheetResolution";
  sheetId: string;
  sheetDigest: string;
  action: QuestionSheetAction;
  state: "resolved" | "blocked";
  answers: ResolvedQuestionAnswer[];
  unresolvedQuestionIds: string[];
  blockedActions: string[];
  digest: string;
}

export function createQuestionSheet(input: {
  title: string;
  trigger: QuestionSheetTrigger;
  instructions?: string;
  estimatedMinutes?: number;
  questions: QuestionSheetQuestion[];
}): QuestionSheet {
  if (!input.title.trim() || input.questions.length === 0) {
    throw new PkrError("PKR-QUESTION-001", "Question sheet requires a title and at least one question");
  }
  const ids = new Set<string>();
  for (const question of input.questions) {
    if (!question.id.trim() || !question.prompt.trim() || ids.has(question.id)) {
      throw new PkrError("PKR-QUESTION-001", "Question sheet question ids and prompts must be non-empty and unique");
    }
    ids.add(question.id);
    if (question.required !== false) {
      throw new PkrError("PKR-QUESTION-001", "Question sheet questions must remain optional");
    }
    if (question.materiality === "protected" && question.skipBehavior !== "block_action") {
      throw new PkrError("PKR-QUESTION-001", "Protected questions must block their actions when skipped");
    }
    if (question.materiality !== "protected" && question.skipBehavior === "block_action") {
      throw new PkrError("PKR-QUESTION-001", "Only protected questions may block actions when skipped");
    }
    validateQuestionAnswer(question, question.recommendation, "recommendation");
  }
  const base = {
    apiVersion: "pkr.question-sheet/v1" as const,
    kind: "QuestionSheet" as const,
    title: input.title.trim(),
    trigger: input.trigger,
    instructions: input.instructions?.trim() || "Only change answers you disagree with; unanswered questions use the recommendation.",
    estimatedMinutes: input.estimatedMinutes ?? 2,
    behavior: {
      sheetSkippable: true as const,
      recommendationsPreselected: true as const,
      triggerPolicy: "critical_forks_only" as const,
      protectedSkipPolicy: "block_action" as const,
    },
    questions: input.questions,
    state: "awaiting_answers" as const,
  };
  const sheetId = derivedId("questions", digest(base));
  const content = { ...base, sheetId };
  return { ...content, digest: digest(content) };
}

function sameValue(left: JsonPrimitive, right: JsonPrimitive): boolean {
  return left === right;
}

function validateQuestionAnswer(
  question: QuestionSheetQuestion,
  answer: JsonValue,
  label: string,
): void {
  if (question.type === "blank") {
    if (typeof answer !== "string" || !answer.trim()) {
      throw new PkrError("PKR-QUESTION-002", `${label} for ${question.id} must be non-empty text`);
    }
    return;
  }
  if (question.type === "multiple_choice") {
    if (!Array.isArray(answer) || answer.length === 0 || answer.some((value) =>
      typeof value === "object" || !question.options.some((option) => sameValue(option.value, value as JsonPrimitive))
    )) {
      throw new PkrError("PKR-QUESTION-002", `${label} for ${question.id} must use declared option values`);
    }
    return;
  }
  if (
    typeof answer === "object" ||
    !question.options.some((option) => sameValue(option.value, answer as JsonPrimitive))
  ) {
    throw new PkrError("PKR-QUESTION-002", `${label} for ${question.id} must use a declared option value`);
  }
}

export function validateQuestionSheet(sheet: QuestionSheet): void {
  const { digest: suppliedDigest, ...content } = sheet;
  if (suppliedDigest !== digest(content)) {
    throw new PkrError("PKR-QUESTION-001", "Question sheet digest does not match its content");
  }
}

export function resolveQuestionSheet(
  sheet: QuestionSheet,
  response: QuestionSheetResponse,
): QuestionSheetResolution {
  validateQuestionSheet(sheet);
  if (!["submit", "accept_recommended", "skip"].includes(response.action)) {
    throw new PkrError("PKR-QUESTION-002", "Question sheet response action is invalid");
  }
  if (!response.answers || typeof response.answers !== "object" || Array.isArray(response.answers)) {
    throw new PkrError("PKR-QUESTION-002", "Question sheet response answers must be an object");
  }
  const knownQuestionIds = new Set(sheet.questions.map((question) => question.id));
  const unknownAnswer = Object.keys(response.answers).find((id) => !knownQuestionIds.has(id));
  if (unknownAnswer) {
    throw new PkrError("PKR-QUESTION-002", `Question sheet response contains unknown question ${unknownAnswer}`);
  }

  const answers: ResolvedQuestionAnswer[] = [];
  const unresolvedQuestionIds: string[] = [];
  const blockedActions = new Set<string>();
  for (const question of sheet.questions) {
    const explicit = response.action === "submit" && Object.hasOwn(response.answers, question.id);
    if (explicit) {
      const value = response.answers[question.id]!;
      validateQuestionAnswer(question, value, "answer");
      answers.push({ questionId: question.id, value, source: "human" });
      if (question.materiality === "protected" && question.type === "approval" && value !== "approve") {
        question.blockedActions.forEach((action) => blockedActions.add(action));
      }
      continue;
    }
    if (response.action === "accept_recommended" || question.skipBehavior === "use_recommendation") {
      answers.push({ questionId: question.id, value: question.recommendation, source: "recommendation" });
      if (question.materiality === "protected") {
        question.blockedActions.forEach((action) => blockedActions.add(action));
      }
      continue;
    }
    unresolvedQuestionIds.push(question.id);
    question.blockedActions.forEach((action) => blockedActions.add(action));
    answers.push({ questionId: question.id, value: null, source: "unresolved" });
  }

  const content = {
    apiVersion: "pkr.question-sheet/v1" as const,
    kind: "QuestionSheetResolution" as const,
    sheetId: sheet.sheetId,
    sheetDigest: sheet.digest,
    action: response.action,
    state: blockedActions.size > 0 ? "blocked" as const : "resolved" as const,
    answers,
    unresolvedQuestionIds,
    blockedActions: [...blockedActions],
  };
  return { ...content, digest: digest(content) };
}

export function answerMap(resolution: QuestionSheetResolution): JsonObject {
  return Object.fromEntries(
    resolution.answers
      .filter((answer) => answer.source !== "unresolved")
      .map((answer) => [answer.questionId, answer.value]),
  );
}
