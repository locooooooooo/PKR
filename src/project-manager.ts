import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { PkrError } from "./errors.js";
import { runRepositoryPreflight } from "./preflight.js";
import { runBoundedProcess, type BoundedProcessResult } from "./process.js";
import {
  answerMap,
  createQuestionSheet,
  resolveQuestionSheet,
  type QuestionSheet,
  type QuestionSheetAction,
  type QuestionSheetQuestion,
  type QuestionSheetResponse,
  type QuestionSheetResolution,
} from "./question-sheet.js";
import type { PkrRuntime } from "./runtime.js";
import type { JsonObject, JsonValue } from "./types.js";
import { derivedId, digest, slug, writeJsonAtomic } from "./util.js";
import { loadVerificationPlan, validateVerificationPlan, type VerificationPlan } from "./verifier.js";

const DEFAULT_MONTHS = 3;
const DEFAULT_DAILY_DAYS = 7;
const GENERATED_BY = "pkr.project-manager";
const UNCONFIGURED_VERIFICATION_COMMAND_ID = "verification-not-configured";
const PLAN_EXTENSION = "pkr.project-manager/plan";
const APPROVAL_EXTENSION = "pkr.project-manager/approval";

export interface ProjectIntakeInput {
  request?: string;
  projectName?: string;
  title?: string;
  outcome?: string;
  audience?: string;
  targetRoot?: string;
  horizonMonths?: number;
  dailyPlanDays?: number;
  verificationPlan?: VerificationPlan;
}

export type ClarificationQuestion = QuestionSheetQuestion;

export interface ProjectMilestone extends JsonObject {
  month: number;
  title: string;
  outcome: string;
}

export interface ProjectDailyPlan extends JsonObject {
  day: number;
  title: string;
  outcome: string;
}

export interface ProjectQuestionnaireProvenance extends JsonObject {
  source: "direct" | "question_sheet";
  sheetId: string | null;
  sheetDigest: string | null;
  action: "direct" | QuestionSheetAction;
  resolutionDigest: string | null;
}

export interface ProjectBootstrapProposal {
  apiVersion: "pkr.project/v1";
  kind: "ProjectBootstrapProposal";
  proposalId: string;
  request: string;
  projectName: string;
  title: string;
  outcome: string;
  audience: string;
  targetRoot: string;
  horizonMonths: number;
  monthlyMilestones: ProjectMilestone[];
  rollingDailyPlan: ProjectDailyPlan[];
  verificationPlan: VerificationPlan;
  questionnaire?: ProjectQuestionnaireProvenance;
  generatedBy: string;
  approval: {
    required: true;
    state: "awaiting_approval";
    requiredActorType: "human";
    approvedBy: string | null;
  };
  state: "awaiting_approval";
  digest: string;
}

export interface ProjectIntakeClarification extends JsonObject {
  apiVersion: "pkr.project/v1";
  kind: "ProjectIntake";
  state: "clarification_required";
  request: string | null;
  questions: ClarificationQuestion[];
  questionSheet: QuestionSheet;
  clarification: {
    state: "awaiting-answers";
    persistence: "pre-runtime";
    trigger: "project-intake";
    questionSheetId: string;
  };
}

export interface ProjectIntakeReady {
  apiVersion: "pkr.project/v1";
  kind: "ProjectIntake";
  state: "awaiting_approval";
  proposal: ProjectBootstrapProposal;
}

export type ProjectIntakeResult = ProjectIntakeClarification | ProjectIntakeReady;

export interface ProjectPlanProjection {
  apiVersion: "pkr.project/v1";
  kind: "ProjectPlanProjection";
  source: {
    authority: "PKR";
    projectId: string;
    projectSequence: number;
    stateDigest: string;
  };
  project: {
    title: string;
    mission: JsonObject;
    goal: JsonObject;
  };
  monthlyMilestones: Array<{
    month: number;
    title: string;
    outcome: string;
    taskId: string;
    phase: string;
  }>;
  rollingDailyPlan: Array<{
    day: number;
    title: string;
    outcome: string;
    taskId: string;
    phase: string;
  }>;
  verification: {
    status: "unconfigured" | "configured_not_run" | "evidence_recorded" | "acceptance_recorded";
    configurationDigest: string;
    commandIds: string[];
    recordedVerificationCount: number;
    passedAcceptanceCount: number;
  };
  readiness: {
    ready: boolean;
    claimReady: boolean;
    verificationReady: boolean;
    state: "initialized_ready" | "initialized_claim_ready" | "initialized_not_ready";
    blockers: Array<{
      id: string;
      code: string;
      message: string;
    }>;
  };
  digest: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integer(value: unknown, fallback: number, label: string, min: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new PkrError("PKR-PROJECT-001", `${label} must be an integer between ${min} and ${max}`);
  }
  return result;
}

interface RecommendedProjectIntake {
  request: string;
  projectName: string;
  outcome: string;
  audience: string;
  targetRoot: string;
  horizonMonths: number;
  dailyPlanDays: number;
}

function recommendedProjectIntake(input: ProjectIntakeInput): RecommendedProjectIntake {
  const targetName = text(input.targetRoot) ? basename(resolve(text(input.targetRoot)!)) : undefined;
  const projectName = slug(text(input.projectName) ?? text(input.title) ?? targetName ?? text(input.request) ?? "pkr-project");
  const request = text(input.request) ?? `Create a governed project named ${projectName}.`;
  return {
    request,
    projectName,
    outcome: text(input.outcome) ?? request,
    audience: text(input.audience) ?? "the project owner and first pilot users",
    targetRoot: resolve(text(input.targetRoot) ?? join(process.cwd(), projectName)),
    horizonMonths: integer(input.horizonMonths, DEFAULT_MONTHS, "horizonMonths", 1, 12),
    dailyPlanDays: integer(input.dailyPlanDays, DEFAULT_DAILY_DAYS, "dailyPlanDays", 1, 14),
  };
}

function blankQuestion(
  id: string,
  prompt: string,
  recommendation: string,
  recommendationReason: string,
): ClarificationQuestion {
  return {
    id,
    prompt,
    type: "blank",
    materiality: "planning",
    required: false,
    recommendation,
    recommendationReason,
    skipBehavior: "use_recommendation",
    blockedActions: [],
    options: [],
  };
}

function questionsFor(input: ProjectIntakeInput): ClarificationQuestion[] {
  const recommended = recommendedProjectIntake(input);
  const horizonOptions = [...new Set([1, 3, 6, 12, recommended.horizonMonths])].sort((left, right) => left - right);
  const dailyOptions = [...new Set([3, 7, 14, recommended.dailyPlanDays])].sort((left, right) => left - right);
  return [
    blankQuestion(
      "request",
      "What should PKR help you do first?",
      recommended.request,
      text(input.request) ? "Uses the request you already supplied." : "Starts with a governed project that can be refined later.",
    ),
    blankQuestion(
      "projectName",
      "What ASCII name should identify the new repository?",
      recommended.projectName,
      text(input.projectName) ? "Uses the project name you already supplied." : "Derives a stable repository-safe name from the available context.",
    ),
    blankQuestion(
      "outcome",
      "What concrete outcome must the project deliver?",
      recommended.outcome,
      text(input.outcome) ? "Uses the outcome you already supplied." : "Keeps the first outcome aligned with the stated request.",
    ),
    blankQuestion(
      "audience",
      "Who is the first intended user or audience?",
      recommended.audience,
      text(input.audience) ? "Uses the audience you already supplied." : "Defaults to the owner and first pilot users until a narrower audience is known.",
    ),
    blankQuestion(
      "targetRoot",
      "Where should the new Git repository and PKR state be created?",
      recommended.targetRoot,
      text(input.targetRoot) ? "Uses the absolute target you already supplied." : "Creates a new child repository under the current directory without mutating it yet.",
    ),
    {
      id: "horizonMonths",
      prompt: "How many months should the first milestone horizon cover?",
      type: "single_choice",
      materiality: "planning",
      required: false,
      recommendation: recommended.horizonMonths,
      recommendationReason: input.horizonMonths === undefined ? "Three months is the bounded PKR planning default." : "Uses the horizon you already supplied.",
      skipBehavior: "use_recommendation",
      blockedActions: [],
      options: horizonOptions.map((value) => ({ value, label: `${value} month${value === 1 ? "" : "s"}`, impact: `Creates ${value} monthly milestone${value === 1 ? "" : "s"}.` })),
    },
    {
      id: "dailyPlanDays",
      prompt: "How many rolling development days should the first plan contain?",
      type: "single_choice",
      materiality: "planning",
      required: false,
      recommendation: recommended.dailyPlanDays,
      recommendationReason: input.dailyPlanDays === undefined ? "Seven days gives one short inspectable development loop." : "Uses the rolling plan length you already supplied.",
      skipBehavior: "use_recommendation",
      blockedActions: [],
      options: dailyOptions.map((value) => ({ value, label: `${value} days`, impact: `Creates a ${value}-day rolling plan.` })),
    },
  ];
}

function needsProjectIntakeQuestions(input: ProjectIntakeInput): boolean {
  return [input.request, input.projectName, input.outcome, input.audience, input.targetRoot]
    .some((value) => !text(value));
}

function projectIntakeQuestionSheet(input: ProjectIntakeInput): QuestionSheet {
  return createQuestionSheet({
    title: "PKR Project Start Sheet",
    trigger: "project_intake",
    instructions: "The whole sheet is optional. Recommendations are preselected; change only the answers you disagree with.",
    estimatedMinutes: 2,
    questions: questionsFor(input),
  });
}

function defaultVerificationPlan(): VerificationPlan {
  return {
    version: "pkr.verify/v1",
    mode: "unconfigured",
    commands: [{
      id: UNCONFIGURED_VERIFICATION_COMMAND_ID,
      executable: process.execPath,
      args: [
        "-e",
        "process.stderr.write('PKR verification plan is not configured\\n'); process.exit(86)",
      ],
      timeoutMs: 30_000,
    }],
    allowedPaths: ["**"],
    forbiddenPaths: [".git/**", ".pkr/**"],
    requireChanges: true,
  };
}

function verificationPlanConfigured(plan: VerificationPlan): boolean {
  return plan.mode !== "unconfigured";
}

function digestBoundExtension(content: JsonObject): JsonObject {
  return { ...content, digest: digest(content) };
}

function buildMilestones(outcome: string, months: number): ProjectMilestone[] {
  return Array.from({ length: months }, (_, index) => {
    const month = index + 1;
    const title = month === 1
      ? "Confirm scope, architecture, and the first executable foundation."
      : month === months
        ? `Independently verify and harden the outcome: ${outcome}`
        : `Deliver the next usable vertical slice toward: ${outcome}`;
    return { month, title, outcome };
  });
}

function buildDailyPlan(outcome: string, days: number): ProjectDailyPlan[] {
  const activities = [
    "Confirm repository baseline and acceptance evidence.",
    "Clarify the smallest executable design.",
    "Implement the bounded project change.",
    "Integrate the change and inspect the real diff.",
    "Run the independent verification commands.",
    "Repair any failed evidence and re-run the checks.",
    "Record the result and re-plan the next rolling day.",
  ];
  return Array.from({ length: days }, (_, index) => ({
    day: index + 1,
    title: activities[index % activities.length]!,
    outcome,
  }));
}

function buildProjectIntakeReady(
  input: ProjectIntakeInput,
  questionnaire: ProjectQuestionnaireProvenance,
): ProjectIntakeReady {
  const request = text(input.request) ?? null;
  const projectName = slug(text(input.projectName)!);
  const title = text(input.title) ?? text(input.projectName)!;
  const outcome = text(input.outcome)!;
  const audience = text(input.audience)!;
  const targetRoot = resolve(text(input.targetRoot)!);
  const horizonMonths = integer(input.horizonMonths, DEFAULT_MONTHS, "horizonMonths", 1, 12);
  const dailyPlanDays = integer(input.dailyPlanDays, DEFAULT_DAILY_DAYS, "dailyPlanDays", 1, 14);
  const verificationPlan = input.verificationPlan ?? defaultVerificationPlan();
  const proposalBase = {
    apiVersion: "pkr.project/v1" as const,
    kind: "ProjectBootstrapProposal" as const,
    request: request!,
    projectName,
    title,
    outcome,
    audience,
    targetRoot,
    horizonMonths,
    monthlyMilestones: buildMilestones(outcome, horizonMonths),
    rollingDailyPlan: buildDailyPlan(outcome, dailyPlanDays),
    verificationPlan,
    questionnaire,
    generatedBy: GENERATED_BY,
    approval: {
      required: true as const,
      state: "awaiting_approval" as const,
      requiredActorType: "human" as const,
      approvedBy: null,
    },
    state: "awaiting_approval" as const,
  };
  const proposal: ProjectBootstrapProposal = {
    ...proposalBase,
    proposalId: derivedId("proposal", digest(proposalBase)),
    digest: digest({ ...proposalBase, proposalId: derivedId("proposal", digest(proposalBase)) }),
  };
  return {
    apiVersion: "pkr.project/v1",
    kind: "ProjectIntake",
    state: "awaiting_approval",
    proposal,
  };
}

export function prepareProjectIntake(input: ProjectIntakeInput): ProjectIntakeResult {
  if (needsProjectIntakeQuestions(input)) {
    const questionSheet = projectIntakeQuestionSheet(input);
    return {
      apiVersion: "pkr.project/v1",
      kind: "ProjectIntake",
      state: "clarification_required",
      request: text(input.request) ?? null,
      questions: questionSheet.questions,
      questionSheet,
      clarification: {
        state: "awaiting-answers",
        persistence: "pre-runtime",
        trigger: "project-intake",
        questionSheetId: questionSheet.sheetId,
      },
    };
  }
  return buildProjectIntakeReady(input, {
    source: "direct",
    sheetId: null,
    sheetDigest: null,
    action: "direct",
    resolutionDigest: null,
  });
}

export function resolveProjectIntake(
  input: ProjectIntakeInput,
  response: QuestionSheetResponse,
): ProjectIntakeReady {
  if (!needsProjectIntakeQuestions(input)) {
    return buildProjectIntakeReady(input, {
      source: "direct",
      sheetId: null,
      sheetDigest: null,
      action: "direct",
      resolutionDigest: null,
    });
  }
  const sheet = projectIntakeQuestionSheet(input);
  const resolution: QuestionSheetResolution = resolveQuestionSheet(sheet, response);
  if (resolution.state === "blocked") {
    throw new PkrError(
      "PKR-PROJECT-009",
      `Project intake remains blocked by: ${resolution.blockedActions.join(", ")}`,
    );
  }
  const answers = answerMap(resolution);
  const resolvedInput: ProjectIntakeInput = {
    request: answers.request as string,
    projectName: answers.projectName as string,
    outcome: answers.outcome as string,
    audience: answers.audience as string,
    targetRoot: answers.targetRoot as string,
    horizonMonths: answers.horizonMonths as number,
    dailyPlanDays: answers.dailyPlanDays as number,
  };
  if (input.title !== undefined) resolvedInput.title = input.title;
  if (input.verificationPlan !== undefined) resolvedInput.verificationPlan = input.verificationPlan;
  return buildProjectIntakeReady(resolvedInput, {
    source: "question_sheet",
    sheetId: sheet.sheetId,
    sheetDigest: sheet.digest,
    action: response.action,
    resolutionDigest: resolution.digest,
  });
}

function questionnaireProvenanceValid(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const provenance = value as JsonObject;
  if (provenance.source === "direct") {
    return provenance.sheetId === null &&
      provenance.sheetDigest === null &&
      provenance.action === "direct" &&
      provenance.resolutionDigest === null;
  }
  return provenance.source === "question_sheet" &&
    typeof provenance.sheetId === "string" && provenance.sheetId.length > 0 &&
    typeof provenance.sheetDigest === "string" && provenance.sheetDigest.startsWith("sha256:") &&
    ["submit", "accept_recommended", "skip"].includes(provenance.action as string) &&
    typeof provenance.resolutionDigest === "string" && provenance.resolutionDigest.startsWith("sha256:");
}

function validateProposal(input: unknown): ProjectBootstrapProposal {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PkrError("PKR-PROJECT-002", "Project bootstrap proposal must be an object");
  }
  const proposal = input as ProjectBootstrapProposal;
  const { digest: suppliedDigest, ...content } = proposal;
  if (
    proposal.apiVersion !== "pkr.project/v1" ||
    proposal.kind !== "ProjectBootstrapProposal" ||
    proposal.state !== "awaiting_approval" ||
    proposal.generatedBy !== GENERATED_BY ||
    proposal.approval?.required !== true ||
    proposal.approval.state !== "awaiting_approval" ||
    proposal.approval.requiredActorType !== "human" ||
    proposal.approval.approvedBy !== null ||
    typeof suppliedDigest !== "string" ||
    suppliedDigest !== digest(content) ||
    !text(proposal.proposalId) ||
    !text(proposal.request) ||
    !text(proposal.projectName) ||
    !text(proposal.title) ||
    !text(proposal.outcome) ||
    !text(proposal.audience) ||
    (proposal.questionnaire !== undefined && !questionnaireProvenanceValid(proposal.questionnaire)) ||
    !isAbsolute(proposal.targetRoot) ||
    !Array.isArray(proposal.monthlyMilestones) ||
    !Array.isArray(proposal.rollingDailyPlan)
  ) {
    throw new PkrError("PKR-PROJECT-002", "Project bootstrap proposal is invalid or its digest does not match");
  }
  integer(proposal.horizonMonths, DEFAULT_MONTHS, "horizonMonths", 1, 12);
  if (proposal.monthlyMilestones.length !== proposal.horizonMonths) {
    throw new PkrError("PKR-PROJECT-002", "monthly milestone count must match horizonMonths");
  }
  if (proposal.rollingDailyPlan.length < 1 || proposal.rollingDailyPlan.length > 14) {
    throw new PkrError("PKR-PROJECT-002", "rolling daily plan must contain 1 to 14 days");
  }
  proposal.monthlyMilestones.forEach((milestone, index) => {
    if (milestone.month !== index + 1 || !text(milestone.title) || !text(milestone.outcome)) {
      throw new PkrError("PKR-PROJECT-002", "monthly milestones must be ordered and complete");
    }
  });
  proposal.rollingDailyPlan.forEach((day, index) => {
    if (day.day !== index + 1 || !text(day.title) || !text(day.outcome)) {
      throw new PkrError("PKR-PROJECT-002", "rolling daily plan must be ordered and complete");
    }
  });
  try {
    // Validate the persisted proposal's independent verification configuration before mutation.
    if (!proposal.verificationPlan) {
      throw new Error("verificationPlan is required");
    }
    validateVerificationPlan(proposal.verificationPlan);
  } catch (error) {
    throw new PkrError("PKR-PROJECT-002", `verification plan is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return proposal;
}

function processSummary(result: BoundedProcessResult): JsonObject {
  return {
    executable: result.executable,
    args: result.args,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    failureReason: result.failureReason,
  };
}

function requireProcessSuccess(result: BoundedProcessResult, operation: string): void {
  if (result.exitCode !== 0 || result.timedOut || result.failureReason !== null) {
    throw new PkrError(
      "PKR-PROJECT-003",
      `${operation} failed: ${result.failureReason ?? (result.stderr.trim() || `exit ${result.exitCode}`)}`,
    );
  }
}

function valueId(value: JsonValue | undefined): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PkrError("PKR-PROJECT-006", "Runtime command did not return an object");
  }
  const object = value as JsonObject;
  const metadata = object.metadata as JsonObject;
  if (typeof metadata?.id !== "string") {
    throw new PkrError("PKR-PROJECT-006", "Runtime command result has no object id");
  }
  return metadata.id;
}

function projectPlanTaskExtensions(options: {
  proposal: ProjectBootstrapProposal;
  approvalDecisionId: string;
  goalId: string;
  planKind: "monthly" | "daily";
  sequence: number;
  title: string;
  outcome: string;
}): JsonObject {
  const content: JsonObject = {
    apiVersion: "pkr.project-plan/v1",
    proposalId: options.proposal.proposalId,
    proposalDigest: options.proposal.digest,
    approvalDecisionId: options.approvalDecisionId,
    goalId: options.goalId,
    planKind: options.planKind,
    sequence: options.sequence,
    title: options.title,
    outcome: options.outcome,
  };
  return { [PLAN_EXTENSION]: digestBoundExtension(content) };
}

export async function bootstrapProject(
  input: unknown,
  approvedBy: string | undefined,
  repositoryRoot: string,
): Promise<JsonObject> {
  const proposal = validateProposal(input);
  if (!approvedBy || !/^human_[a-z0-9._-]+$/i.test(approvedBy)) {
    throw new PkrError("PKR-PROJECT-004", "Project bootstrap requires an explicit human approver");
  }
  if (approvedBy === proposal.generatedBy) {
    throw new PkrError("PKR-PROJECT-004", "proposal generator cannot approve its own project bootstrap");
  }
  const targetRoot = resolve(proposal.targetRoot);
  if (existsSync(targetRoot)) {
    throw new PkrError("PKR-PROJECT-005", `target project directory already exists: ${targetRoot}`, "conflict");
  }
  if (!existsSync(dirname(targetRoot))) {
    throw new PkrError("PKR-PROJECT-005", `target parent directory does not exist: ${dirname(targetRoot)}`);
  }

  let created = false;
  let runtime: PkrRuntime | undefined;
  const gitEvidence: JsonObject[] = [];
  try {
    await mkdir(targetRoot);
    created = true;
    await writeFile(join(targetRoot, "README.md"), `# ${proposal.title}\n\n${proposal.outcome}\n\nAudience: ${proposal.audience}\n`, "utf8");
    await writeFile(
      join(targetRoot, ".gitignore"),
      ".pkr/runtime.sqlite\n.pkr/runtime.sqlite-*\n.pkr/projections/\nnode_modules/\ndist/\n",
      "utf8",
    );

    const init = await runBoundedProcess({ executable: "git", args: ["init", "-b", "main"], cwd: targetRoot });
    gitEvidence.push({ operation: "git-init", ...processSummary(init) });
    requireProcessSuccess(init, "git init");

    runtime = await (await import("./runtime.js")).PkrRuntime.init(targetRoot, repositoryRoot, {
      name: proposal.projectName,
      title: proposal.title,
      outcome: proposal.outcome,
      description: `Project Manager bootstrap for ${proposal.audience}.`,
      authorityId: approvedBy,
      requestId: proposal.proposalId,
    });
    if (process.env.PKR_PROJECT_MANAGER_FAILPOINT === "after-runtime-init") {
      throw new Error("PKR project manager failpoint after-runtime-init");
    }

    const approvalContent: JsonObject = {
      apiVersion: "pkr.project-approval/v1",
      proposalId: proposal.proposalId,
      proposalDigest: proposal.digest,
      approvedBy,
    };
    const decision = await runtime.createDecision(
      `Should the Project accept bootstrap proposal ${proposal.proposalId}?`,
      `Approve ${proposal.projectName} for ${proposal.audience}.`,
      `Human owner ${approvedBy} approved proposal digest ${proposal.digest}.`,
      ["Mission", "Goal", "Task", "Decision", "Verification"],
      approvedBy,
      derivedId("command", `${proposal.proposalId}:decision`),
      { [APPROVAL_EXTENSION]: digestBoundExtension(approvalContent) },
    );
    const decisionId = valueId(decision.value);
    const goal = await runtime.createGoal(
      proposal.outcome,
      approvedBy,
      derivedId("command", `${proposal.proposalId}:goal`),
    );
    const goalId = valueId(goal.value);
    const monthlyTasks: JsonObject[] = [];
    for (const milestone of proposal.monthlyMilestones) {
      const task = await runtime.createTask(
        goalId,
        `Month ${milestone.month} milestone: ${milestone.title}`,
        approvedBy,
        derivedId("command", `${proposal.proposalId}:month:${milestone.month}`),
        projectPlanTaskExtensions({
          proposal,
          approvalDecisionId: decisionId,
          goalId,
          planKind: "monthly",
          sequence: milestone.month,
          title: milestone.title,
          outcome: milestone.outcome,
        }),
      );
      monthlyTasks.push({ month: milestone.month, taskId: valueId(task.value), title: milestone.title, outcome: milestone.outcome });
    }
    const dailyTasks: JsonObject[] = [];
    for (const day of proposal.rollingDailyPlan) {
      const task = await runtime.createTask(
        goalId,
        `Day ${day.day} rolling: ${day.title}`,
        approvedBy,
        derivedId("command", `${proposal.proposalId}:day:${day.day}`),
        projectPlanTaskExtensions({
          proposal,
          approvalDecisionId: decisionId,
          goalId,
          planKind: "daily",
          sequence: day.day,
          title: day.title,
          outcome: day.outcome,
        }),
      );
      dailyTasks.push({ day: day.day, taskId: valueId(task.value), title: day.title, outcome: day.outcome });
    }

    await writeJsonAtomic(join(targetRoot, ".pkr", "verification.json"), proposal.verificationPlan as unknown as JsonValue);

    const add = await runBoundedProcess({
      executable: "git",
      args: ["add", "README.md", ".gitignore", ".pkr/config.json", ".pkr/verification.json"],
      cwd: targetRoot,
    });
    gitEvidence.push({ operation: "git-add", ...processSummary(add) });
    requireProcessSuccess(add, "git add");
    const commit = await runBoundedProcess({
      executable: "git",
      args: [
        "-c", "user.name=PKR Bootstrap",
        "-c", "user.email=pkr-bootstrap@local.invalid",
        "commit", "-m", "Initialize PKR project",
      ],
      cwd: targetRoot,
    });
    gitEvidence.push({ operation: "git-commit", ...processSummary(commit) });
    requireProcessSuccess(commit, "git commit");

    const plan = await writeProjectPlanProjection(runtime);
    const status = runtime.status();
    return {
      apiVersion: "pkr.project/v1",
      kind: "ProjectBootstrapResult",
      state: plan.readiness.state,
      proposalId: proposal.proposalId,
      approvedBy,
      targetRoot,
      git: gitEvidence,
      project: status,
      decisionId,
      goalId,
      monthlyTasks,
      dailyTasks,
      verification: {
        status: plan.verification.status,
        planDigest: digest(proposal.verificationPlan),
        acceptanceRecords: plan.verification.passedAcceptanceCount,
      },
      readiness: plan.readiness as unknown as JsonObject,
      plan: plan as unknown as JsonObject,
    };
  } catch (error) {
    runtime?.close();
    runtime = undefined;
    if (created) {
      await rm(targetRoot, { recursive: true, force: true });
    }
    throw error;
  } finally {
    runtime?.close();
  }
}

function taskPhase(runtime: PkrRuntime, taskId: string): string {
  const status = runtime.getRecord("Task", taskId).data.status as JsonObject;
  return status.phase as string;
}

interface ValidatedPlanTask {
  taskId: string;
  phase: string;
  planKind: "monthly" | "daily";
  sequence: number;
  title: string;
  outcome: string;
  goalId: string;
  proposalId: string;
  proposalDigest: string;
  approvalDecisionId: string;
}

function contentWithValidDigest(value: JsonObject, label: string): JsonObject {
  const suppliedDigest = value.digest;
  const { digest: _ignored, ...content } = value;
  if (typeof suppliedDigest !== "string" || suppliedDigest !== digest(content)) {
    throw new PkrError("PKR-PROJECT-008", `${label} digest is missing or invalid`);
  }
  return content;
}

function relatedGoalId(task: JsonObject): string {
  const relation = (task.relations as JsonObject[]).find((candidate) => {
    const target = candidate.target as JsonObject | undefined;
    return candidate.type === "contributesTo" && target?.kind === "Goal" && typeof target.id === "string";
  });
  const goalId = (relation?.target as JsonObject | undefined)?.id;
  if (typeof goalId !== "string") {
    throw new PkrError("PKR-PROJECT-008", "Project Manager plan Task has no Goal relation");
  }
  return goalId;
}

function validatePlanTask(runtime: PkrRuntime, taskId: string, task: JsonObject): ValidatedPlanTask | undefined {
  const extension = (task.extensions as JsonObject | undefined)?.[PLAN_EXTENSION];
  if (extension === undefined) {
    return undefined;
  }
  if (!extension || typeof extension !== "object" || Array.isArray(extension)) {
    throw new PkrError("PKR-PROJECT-008", `Task/${taskId} has malformed Project Manager provenance`);
  }
  const content = contentWithValidDigest(extension as JsonObject, `Task/${taskId} plan provenance`);
  const goalId = relatedGoalId(task);
  if (
    content.apiVersion !== "pkr.project-plan/v1" ||
    (content.planKind !== "monthly" && content.planKind !== "daily") ||
    !Number.isInteger(content.sequence) ||
    (content.sequence as number) < 1 ||
    typeof content.title !== "string" || !content.title ||
    typeof content.outcome !== "string" || !content.outcome ||
    typeof content.proposalId !== "string" || !content.proposalId ||
    typeof content.proposalDigest !== "string" || !content.proposalDigest ||
    typeof content.approvalDecisionId !== "string" || !content.approvalDecisionId ||
    content.goalId !== goalId
  ) {
    throw new PkrError("PKR-PROJECT-008", `Task/${taskId} Project Manager provenance is incomplete`);
  }
  const metadata = task.metadata as JsonObject;
  if (metadata.createdBy !== runtime.ownerId()) {
    throw new PkrError("PKR-PROJECT-008", `Task/${taskId} plan provenance was not created by the Project owner`);
  }
  return {
    taskId,
    phase: taskPhase(runtime, taskId),
    planKind: content.planKind,
    sequence: content.sequence as number,
    title: content.title,
    outcome: content.outcome,
    goalId,
    proposalId: content.proposalId,
    proposalDigest: content.proposalDigest,
    approvalDecisionId: content.approvalDecisionId,
  } as ValidatedPlanTask;
}

function validatePlanApproval(runtime: PkrRuntime, planTask: ValidatedPlanTask): void {
  const decision = runtime.getRecord("Decision", planTask.approvalDecisionId).data;
  const metadata = decision.metadata as JsonObject;
  const status = decision.status as JsonObject;
  const extension = (decision.extensions as JsonObject | undefined)?.[APPROVAL_EXTENSION];
  if (
    metadata.createdBy !== runtime.ownerId() ||
    status.phase !== "accepted" ||
    !extension || typeof extension !== "object" || Array.isArray(extension)
  ) {
    throw new PkrError("PKR-PROJECT-008", "Project Manager plan has no accepted owner approval provenance");
  }
  const content = contentWithValidDigest(extension as JsonObject, "Project Manager approval provenance");
  if (
    content.apiVersion !== "pkr.project-approval/v1" ||
    content.proposalId !== planTask.proposalId ||
    content.proposalDigest !== planTask.proposalDigest ||
    content.approvedBy !== runtime.ownerId()
  ) {
    throw new PkrError("PKR-PROJECT-008", "Project Manager approval does not match its plan Tasks");
  }
}

function orderPlanTasks(tasks: ValidatedPlanTask[], label: string): ValidatedPlanTask[] {
  const ordered = [...tasks].sort((left, right) => left.sequence - right.sequence);
  if (ordered.length === 0 || ordered.some((task, index) => task.sequence !== index + 1)) {
    throw new PkrError("PKR-PROJECT-008", `${label} plan provenance must have contiguous unique sequence numbers`);
  }
  return ordered;
}

function verificationTargetsPlanTask(record: JsonObject, taskIds: Set<string>): boolean {
  return (record.relations as JsonObject[]).some((relation) => {
    const target = relation.target as JsonObject | undefined;
    return relation.type === "verifies" && target?.kind === "Task" &&
      typeof target.id === "string" && taskIds.has(target.id);
  });
}

export async function buildProjectPlanProjection(runtime: PkrRuntime): Promise<ProjectPlanProjection> {
  const manifest = runtime.getRecord("ProjectManifest", runtime.projectId).data;
  const missionId = (manifest.mission as JsonObject).activeMissionId as string;
  const mission = runtime.getRecord("Mission", missionId).data;
  const taskRecords = runtime.listRecords("Task");
  const planTasks = taskRecords
    .map((record) => validatePlanTask(runtime, record.id, record.data))
    .filter((task): task is ValidatedPlanTask => task !== undefined);
  if (planTasks.length === 0) {
    const legacyPlanTasks = taskRecords.some((record) => {
      const objective = (record.data.spec as JsonObject).objective;
      return typeof objective === "string" && /^(?:Month \d+ milestone|Day \d+ rolling):/.test(objective);
    });
    if (legacyPlanTasks) {
      throw new PkrError(
        "PKR-PROJECT-007",
        "legacy Project Manager Tasks have no structured provenance; re-bootstrap or migrate them before rebuilding",
      );
    }
    throw new PkrError("PKR-PROJECT-006", "Project Manager plan Tasks are missing");
  }
  const identity = planTasks[0]!;
  if (planTasks.some((task) =>
    task.goalId !== identity.goalId ||
    task.proposalId !== identity.proposalId ||
    task.proposalDigest !== identity.proposalDigest ||
    task.approvalDecisionId !== identity.approvalDecisionId
  )) {
    throw new PkrError("PKR-PROJECT-008", "Project Manager plan Tasks do not share one approved proposal and Goal");
  }
  validatePlanApproval(runtime, identity);
  const monthlyTasks = orderPlanTasks(planTasks.filter((task) => task.planKind === "monthly"), "monthly");
  const dailyTasks = orderPlanTasks(planTasks.filter((task) => task.planKind === "daily"), "daily");
  const monthlyMilestones: ProjectPlanProjection["monthlyMilestones"] = monthlyTasks.map((task) => ({
    month: task.sequence,
    title: task.title,
    outcome: task.outcome,
    taskId: task.taskId,
    phase: task.phase,
  }));
  const rollingDailyPlan: ProjectPlanProjection["rollingDailyPlan"] = dailyTasks.map((task) => ({
    day: task.sequence,
    title: task.title,
    outcome: task.outcome,
    taskId: task.taskId,
    phase: task.phase,
  }));
  const goal = runtime.getRecord("Goal", identity.goalId).data;
  const verificationPath = join(runtime.paths.stateDir, "verification.json");
  const verificationPlan = await loadVerificationPlan(verificationPath);
  const planTaskIds = new Set(planTasks.map((task) => task.taskId));
  const relatedVerifications = runtime.listRecords("Verification").filter((record) =>
    verificationTargetsPlanTask(record.data, planTaskIds)
  );
  const passedAcceptanceCount = relatedVerifications.filter((record) =>
    (record.data.spec as JsonObject).gate === "acceptance" &&
    (record.data.status as JsonObject).phase === "passed"
  ).length;
  const verificationStatus = !verificationPlanConfigured(verificationPlan)
    ? "unconfigured" as const
    : passedAcceptanceCount > 0
      ? "acceptance_recorded" as const
      : relatedVerifications.length > 0
        ? "evidence_recorded" as const
        : "configured_not_run" as const;
  const preflight = await runRepositoryPreflight(runtime.paths.root, runtime.repositoryRoot, {
    verificationFile: verificationPath,
  });
  const blockers = preflight.checks
    .filter((check) => check.status !== "pass")
    .map((check) => ({
      id: check.id,
      code: check.code ?? "PKR-PREFLIGHT-BLOCKED",
      message: check.message,
    }));
  const claimCheckIds = new Set(["node", "git", "runtime", "agent-native"]);
  const claimReady = preflight.checks
    .filter((check) => claimCheckIds.has(check.id))
    .every((check) => check.status === "pass");
  const verificationReady = preflight.checks
    .filter((check) => check.id === "verification-config" || check.id === "verification-executables")
    .every((check) => check.status === "pass");
  const content = {
    apiVersion: "pkr.project/v1" as const,
    kind: "ProjectPlanProjection" as const,
    source: {
      authority: "PKR" as const,
      projectId: runtime.projectId,
      projectSequence: runtime.status().projectSequence as number,
      stateDigest: runtime.stateDigest(),
    },
    project: {
      title: ((manifest.metadata as JsonObject).title as string),
      mission,
      goal,
    },
    monthlyMilestones,
    rollingDailyPlan,
    verification: {
      status: verificationStatus,
      configurationDigest: digest(verificationPlan),
      commandIds: verificationPlan.commands.map((command) => command.id),
      recordedVerificationCount: relatedVerifications.length,
      passedAcceptanceCount,
    },
    readiness: {
      ready: preflight.ready,
      claimReady,
      verificationReady,
      state: preflight.ready
        ? "initialized_ready" as const
        : claimReady ? "initialized_claim_ready" as const : "initialized_not_ready" as const,
      blockers,
    },
  };
  return { ...content, digest: digest(content) };
}

export async function writeProjectPlanProjection(runtime: PkrRuntime): Promise<ProjectPlanProjection> {
  await runtime.rebuildProjections();
  const plan = await buildProjectPlanProjection(runtime);
  await writeJsonAtomic(join(runtime.paths.projections, "project-manager", "plan.json"), plan as unknown as JsonValue);
  return plan;
}

export async function readProjectPlan(runtime: PkrRuntime): Promise<ProjectPlanProjection> {
  return buildProjectPlanProjection(runtime);
}

export async function readProjectProposal(path: string): Promise<ProjectBootstrapProposal> {
  const content = await readFile(resolve(path), "utf8");
  return validateProposal(JSON.parse(content.replace(/^\uFEFF/, "")));
}
