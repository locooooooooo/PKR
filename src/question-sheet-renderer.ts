import { PkrError } from "./errors.js";
import type {
  QuestionSheet,
  QuestionSheetQuestion,
  QuestionType,
} from "./question-sheet.js";
import { validateQuestionSheet } from "./question-sheet.js";

export type QuestionSurface = "chat" | "cli";
export type QuestionLayout = "sectioned" | "compact";

export interface PresentationProfile {
  surface: QuestionSurface;
  locale: "zh-CN" | "en-US";
  layout: QuestionLayout;
  supportsBatchAnswers: boolean;
  supportsMultipleChoice: boolean;
  supportsFreeText: boolean;
  supportsExplicitApproval: boolean;
}

export const CHAT_MARKDOWN_PROFILE: PresentationProfile = {
  surface: "chat",
  locale: "zh-CN",
  layout: "sectioned",
  supportsBatchAnswers: true,
  supportsMultipleChoice: true,
  supportsFreeText: true,
  supportsExplicitApproval: true,
};

export const CLI_COMPACT_PROFILE: PresentationProfile = {
  surface: "cli",
  locale: "zh-CN",
  layout: "compact",
  supportsBatchAnswers: true,
  supportsMultipleChoice: true,
  supportsFreeText: true,
  supportsExplicitApproval: true,
};

export interface RenderedQuestionSheet {
  apiVersion: "pkr.question-sheet-render/v1";
  kind: "RenderedQuestionSheet";
  sheetId: string;
  sheetDigest: string;
  profile: PresentationProfile;
  text: string;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function valueText(value: unknown): string {
  if (Array.isArray(value)) return value.map(valueText).join(", ");
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function questionKind(type: QuestionType, locale: PresentationProfile["locale"]): string {
  if (locale === "en-US") {
    return {
      single_choice: "Single choice",
      multiple_choice: "Multiple choice",
      blank: "Fill in",
      approval: "Approval",
    }[type];
  }
  return {
    single_choice: "选择题",
    multiple_choice: "多选题",
    blank: "填空题",
    approval: "拍板题",
  }[type];
}

function validateProfile(sheet: QuestionSheet, profile: PresentationProfile): void {
  for (const question of sheet.questions) {
    if (question.type === "multiple_choice" && !profile.supportsMultipleChoice) {
      throw new PkrError("PKR-QUESTION-003", `Presentation profile ${profile.surface} cannot render multiple-choice questions`);
    }
    if (question.type === "blank" && !profile.supportsFreeText) {
      throw new PkrError("PKR-QUESTION-003", `Presentation profile ${profile.surface} cannot render fill-in questions`);
    }
    if (question.type === "approval" && !profile.supportsExplicitApproval) {
      throw new PkrError("PKR-QUESTION-003", `Presentation profile ${profile.surface} cannot render approval questions`);
    }
  }
}

function recommendedMark(question: QuestionSheetQuestion, value: unknown): string {
  if (Array.isArray(question.recommendation)) {
    return question.recommendation.some((item) => item === value) ? "（推荐）" : "";
  }
  return question.recommendation === value ? "（推荐）" : "";
}

function protectedNote(question: QuestionSheetQuestion, locale: PresentationProfile["locale"]): string {
  if (question.materiality !== "protected") return "";
  return locale === "en-US"
    ? ` Protected action remains blocked if this question is skipped: ${question.blockedActions.join(", ")}.`
    : ` 跳过后仍阻塞受保护动作：${question.blockedActions.join(", ")}。`;
}

function renderQuestion(
  question: QuestionSheetQuestion,
  number: number,
  profile: PresentationProfile,
  compact: boolean,
): string[] {
  const locale = profile.locale;
  const lines = [`${number}. ${question.prompt} [${questionKind(question.type, locale)}]`];
  if (question.type === "blank") {
    lines.push(compact
      ? `   ${locale === "en-US" ? "recommended" : "推荐"}: ${valueText(question.recommendation)}`
      : `   ${locale === "en-US" ? "Recommended answer" : "推荐填写"}: ${valueText(question.recommendation)}`);
  } else {
    question.options.forEach((option, index) => {
      const marker = index < LETTERS.length ? LETTERS[index] : String(index + 1);
      const recommended = recommendedMark(question, option.value);
      lines.push(`   ${marker}. ${option.label}${recommended} - ${option.impact}`);
    });
  }
  lines.push(compact
    ? `   ${locale === "en-US" ? "skip" : "跳过"}: ${question.skipBehavior}${protectedNote(question, locale)}`
    : `   ${locale === "en-US" ? "Why" : "推荐理由"}: ${question.recommendationReason}${protectedNote(question, locale)}`);
  return lines;
}

function renderChat(sheet: QuestionSheet, profile: PresentationProfile): string {
  const locale = profile.locale;
  const groups = new Map<QuestionType, QuestionSheetQuestion[]>();
  for (const question of sheet.questions) {
    const group = groups.get(question.type) ?? [];
    group.push(question);
    groups.set(question.type, group);
  }
  const lines = [
    `# ${sheet.title}`,
    "",
    `- ${locale === "en-US" ? "Estimated time" : "预计用时"}: ${sheet.estimatedMinutes} min`,
    `- ${locale === "en-US" ? "Sheet" : "试卷"}: \`${sheet.sheetId}\``,
    `- ${locale === "en-US" ? "Digest" : "摘要"}: \`${sheet.digest}\``,
    "",
    `> ${sheet.instructions}`,
    `> ${locale === "en-US" ? "The whole sheet is optional. Change only answers you disagree with." : "整卷可跳过；只修改你不同意的推荐答案。"}`,
  ];
  let number = 1;
  for (const type of ["single_choice", "multiple_choice", "blank", "approval"] as QuestionType[]) {
    const questions = groups.get(type);
    if (!questions?.length) continue;
    lines.push("", `## ${questionKind(type, locale)}`);
    for (const question of questions) {
      lines.push(...renderQuestion(question, number, profile, false));
      number += 1;
    }
  }
  lines.push(
    "",
    `## ${locale === "en-US" ? "Submit" : "提交方式"}`,
    `- \`accept_recommended\`: ${locale === "en-US" ? "accept all recommendations" : "接受全部推荐"}`,
    `- \`skip\`: ${locale === "en-US" ? "skip the sheet; protected actions stay blocked" : "跳过整卷；重大事项仍保持阻塞"}`,
    `- \`submit\`: ${locale === "en-US" ? "submit only changed answers" : "只提交修改过的答案"}`,
  );
  return `${lines.join("\n")}\n`;
}

function renderCli(sheet: QuestionSheet, profile: PresentationProfile): string {
  const locale = profile.locale;
  const lines = [
    `${sheet.title} [${sheet.sheetId}]`,
    `${locale === "en-US" ? "digest" : "摘要"}: ${sheet.digest}`,
    `${locale === "en-US" ? "time" : "用时"}: ${sheet.estimatedMinutes} min | ${sheet.instructions}`,
    "",
  ];
  sheet.questions.forEach((question, index) => {
    lines.push(...renderQuestion(question, index + 1, profile, true));
  });
  lines.push(
    "",
    `${locale === "en-US" ? "actions" : "操作"}: accept_recommended | skip | submit`,
    `${locale === "en-US" ? "answers" : "答案"}: JSON object keyed by question id`,
  );
  return `${lines.join("\n")}\n`;
}

export function renderQuestionSheet(
  sheet: QuestionSheet,
  profile: PresentationProfile = CHAT_MARKDOWN_PROFILE,
): RenderedQuestionSheet {
  validateQuestionSheet(sheet);
  validateProfile(sheet, profile);
  const text = profile.layout === "compact"
    ? renderCli(sheet, profile)
    : renderChat(sheet, profile);
  return {
    apiVersion: "pkr.question-sheet-render/v1",
    kind: "RenderedQuestionSheet",
    sheetId: sheet.sheetId,
    sheetDigest: sheet.digest,
    profile,
    text,
  };
}
