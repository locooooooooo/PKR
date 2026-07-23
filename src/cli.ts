#!/usr/bin/env node

import { COPYFILE_EXCL } from "node:constants";
import { copyFile, lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCliInvocation } from "./cli-contract.js";
import { isPkrError, PkrError } from "./errors.js";
import type {
  EvolutionCandidateSpec,
  EvolutionObservationSpec,
  GovernancePolicyContent,
  ManagedAdapterContent,
} from "./evolution-model.js";
import type { AgentNativeSubmission } from "./lps.js";
import { STARTER_PROFILES, type StarterProfileName } from "./profiles.js";
import { loadLocalProviderConfig } from "./provider.js";
import type {
  InitOptions,
  JsonObject,
  JsonValue,
  MetricThreshold,
  MetricThresholdOperator,
} from "./types.js";
import { loadVerificationPlan, runLocalVerification } from "./verifier.js";
import { collectRepositoryEvidence } from "./workspace.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const QUICKSTART_FILES = ["verification.json", "verify.mjs"] as const;

interface QuickstartSetupResult {
  created: string[];
  skipped: string[];
  overwritten: string[];
  targetPath: string;
  nextCommand: string;
}

async function existingPath(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function setupQuickstart(projectRoot: string, force: boolean): Promise<QuickstartSetupResult> {
  const statePath = join(projectRoot, ".pkr");
  const stateStat = await existingPath(statePath);
  const databaseStat = await existingPath(join(statePath, "runtime.sqlite"));
  const configStat = await existingPath(join(statePath, "config.json"));
  if (
    !stateStat ||
    stateStat.isSymbolicLink() ||
    !stateStat.isDirectory() ||
    !databaseStat ||
    databaseStat.isSymbolicLink() ||
    !databaseStat.isFile() ||
    !configStat ||
    configStat.isSymbolicLink() ||
    !configStat.isFile()
  ) {
    throw new PkrError(
      "PKR-RUNTIME-007",
      "no PKR project found in this directory; run pkr init first",
    );
  }

  const fixtureRoot = join(repositoryRoot, "examples", "quickstart");
  const created: string[] = [];
  const skipped: string[] = [];
  const overwritten: string[] = [];
  for (const file of QUICKSTART_FILES) {
    const source = join(fixtureRoot, file);
    const target = join(statePath, file);
    const targetStat = await existingPath(target);
    if (targetStat) {
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
        throw new PkrError(
          "PKR-SETUP-001",
          `refusing to write non-regular quickstart target ${target}`,
        );
      }
      if (!force) {
        skipped.push(file);
        continue;
      }
      await copyFile(source, target);
      overwritten.push(file);
      continue;
    }
    try {
      await copyFile(source, target, COPYFILE_EXCL);
      created.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      skipped.push(file);
    }
  }

  return {
    created,
    skipped,
    overwritten,
    targetPath: statePath,
    nextCommand: `pkr doctor --project "${projectRoot}"`,
  };
}

function option(args: string[], name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) {
    throw new Error(`missing required option ${name}`);
  }
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseJsonText(value: string): unknown {
  return JSON.parse(value.replace(/^\uFEFF/, ""));
}

async function questionResponse(
  args: string[],
): Promise<import("./question-sheet.js").QuestionSheetResponse | undefined> {
  const answersFile = option(args, "--answers-file");
  const acceptRecommended = args.includes("--accept-recommended");
  const skipQuestions = args.includes("--skip-questions");
  if ([Boolean(answersFile), acceptRecommended, skipQuestions].filter(Boolean).length > 1) {
    throw new Error("provide at most one of --answers-file, --accept-recommended, or --skip-questions");
  }
  if (answersFile) {
    const parsed = parseJsonText(await readFile(resolve(answersFile), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--answers-file must contain a JSON object");
    }
    const object = parsed as JsonObject;
    return Object.hasOwn(object, "action")
      ? object as import("./question-sheet.js").QuestionSheetResponse
      : { action: "submit", answers: object };
  }
  if (acceptRecommended) return { action: "accept_recommended", answers: {} };
  if (skipQuestions) return { action: "skip", answers: {} };
  return undefined;
}

async function jsonInput(
  args: string[],
  inlineOption: string,
  fileOption: string,
): Promise<unknown> {
  const inline = option(args, inlineOption);
  const file = option(args, fileOption);
  if ((!inline && !file) || (inline && file)) {
    throw new Error(`provide exactly one of ${inlineOption} or ${fileOption}`);
  }
  return parseJsonText(file
    ? await readFile(resolve(file), "utf8")
    : inline!);
}

async function optionalJsonInput(
  args: string[],
  inlineOption: string,
  fileOption: string,
): Promise<unknown | undefined> {
  const inline = option(args, inlineOption);
  const file = option(args, fileOption);
  if (inline && file) {
    throw new Error(`provide at most one of ${inlineOption} or ${fileOption}`);
  }
  if (!inline && !file) {
    return undefined;
  }
  return parseJsonText(file
    ? await readFile(resolve(file), "utf8")
    : inline!);
}

async function textInput(
  args: string[],
  inlineOption: string,
  fileOption: string,
): Promise<string> {
  const inline = option(args, inlineOption);
  const file = option(args, fileOption);
  if ((!inline && !file) || (inline && file)) {
    throw new Error(`provide exactly one of ${inlineOption} or ${fileOption}`);
  }
  return file ? readFile(resolve(file), "utf8") : inline!;
}

function scalarJson(args: string[], name: string): string | number | boolean {
  const value = JSON.parse(required(args, name)) as JsonValue;
  if (value === null || Array.isArray(value) || typeof value === "object") {
    throw new Error(`${name} must be a JSON string, number, or boolean`);
  }
  return value;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const invocation = parseCliInvocation(args);
  if (invocation.help) {
    process.stdout.write(`${invocation.helpText}\n`);
    return 0;
  }
  const [
    { ClarificationService },
    { createDiagnosticExport },
    { EvolutionService },
    { LpsOrchestrator },
    { MemoryService },
    { PackageService },
    projectManager,
    questionRenderer,
    { runRepositoryPreflight },
    { PkrRuntime },
    { StewardService },
    { SupervisorRunner },
  ] = await Promise.all([
    import("./clarification.js"),
    import("./security.js"),
    import("./evolution.js"),
    import("./lps.js"),
    import("./memory.js"),
    import("./packages.js"),
    import("./project-manager.js"),
    import("./question-sheet-renderer.js"),
    import("./preflight.js"),
    import("./runtime.js"),
    import("./steward.js"),
    import("./supervisor.js"),
  ]);
  const projectRoot = resolve(option(args, "--project", process.cwd())!);
  const command = args[0];

  if (command === "setup") {
    if (!args.includes("--quickstart")) {
      throw new Error("setup requires --quickstart");
    }
    print(await setupQuickstart(projectRoot, args.includes("--force")));
    return 0;
  }

  if (command === "doctor") {
    const report = await runRepositoryPreflight(projectRoot, repositoryRoot, {
      providerFile: option(args, "--provider-file", join(projectRoot, ".pkr", "provider.json"))!,
      verificationFile: option(
        args,
        "--verification-file",
        join(projectRoot, ".pkr", "verification.json"),
      )!,
      adapter: args.includes("--adapter") || option(args, "--provider-file") !== undefined,
    });
    print(report);
    return report.ready ? 0 : 2;
  }

  if (command === "init") {
    const name = option(args, "--name", "pkr-project")!;
    const description = option(args, "--description");
    const authorityId = option(args, "--authority");
    const requestId = option(args, "--command-id");
    const initOptions: InitOptions = {
      name,
      title: option(args, "--title", name)!,
      outcome: option(args, "--outcome", `Deliver ${name} through governed AI-native development.`)!,
      ...(description ? { description } : {}),
      ...(authorityId ? { authorityId } : {}),
      ...(requestId ? { requestId } : {}),
    };
    const runtime = await PkrRuntime.init(projectRoot, repositoryRoot, initOptions);
    try {
      print(runtime.status());
    } finally {
      runtime.close();
    }
    return 0;
  }

  if (command === "project" && args[1] === "intake") {
    const requestInline = option(args, "--request");
    const requestFile = option(args, "--request-file");
    if (requestInline && requestFile) {
      throw new Error("provide at most one of --request and --request-file");
    }
    const request = requestFile
      ? await readFile(resolve(requestFile), "utf8")
      : requestInline;
    const verificationFile = option(args, "--verification-file");
    const verificationPlan = verificationFile
      ? await loadVerificationPlan(verificationFile)
      : undefined;
    const intake: import("./project-manager.js").ProjectIntakeInput = {};
    const name = option(args, "--name");
    const title = option(args, "--title");
    const outcome = option(args, "--outcome");
    const audience = option(args, "--audience");
    const targetRoot = option(args, "--target");
    const months = option(args, "--months");
    const days = option(args, "--days");
    if (request !== undefined) intake.request = request;
    if (name) intake.projectName = name;
    if (title) intake.title = title;
    if (outcome) intake.outcome = outcome;
    if (audience) intake.audience = audience;
    if (targetRoot) intake.targetRoot = targetRoot;
    if (months) intake.horizonMonths = Number(months);
    if (days) intake.dailyPlanDays = Number(days);
    if (verificationPlan) intake.verificationPlan = verificationPlan;
    const questionFormat = option(args, "--question-format");
    if (questionFormat && questionFormat !== "chat" && questionFormat !== "cli") {
      throw new Error("--question-format must be chat or cli");
    }
    const response = await questionResponse(args);
    const intakeResult = response
      ? projectManager.resolveProjectIntake(intake, response)
      : projectManager.prepareProjectIntake(intake);
    if (questionFormat && intakeResult.state === "clarification_required") {
      const profile = questionFormat === "chat"
        ? questionRenderer.CHAT_MARKDOWN_PROFILE
        : questionRenderer.CLI_COMPACT_PROFILE;
      process.stdout.write(questionRenderer.renderQuestionSheet(intakeResult.questionSheet, profile).text);
    } else {
      print(intakeResult);
    }
    return 0;
  }

  if (command === "project" && args[1] === "bootstrap") {
    const proposal = await jsonInput(args, "--proposal", "--proposal-file");
    print(await projectManager.bootstrapProject(proposal, option(args, "--approve-by"), repositoryRoot));
    return 0;
  }

  const runtime = await PkrRuntime.open(projectRoot, repositoryRoot);
  try {
    const lps = new LpsOrchestrator(runtime);
    const evolution = new EvolutionService(runtime);
    const memory = new MemoryService(runtime);
    const packages = new PackageService(runtime);
    if (command === "status") {
      print(runtime.status());
      return 0;
    }
    if (command === "diagnostics" && args[1] === "export") {
      print(createDiagnosticExport(runtime));
      return 0;
    }
    const clarification = new ClarificationService(runtime);
    if (command === "clarification" && args[1] === "assess") {
      const trigger = option(args, "--trigger", "execution-checkpoint")!;
      if (!["steward-request", "goal-review", "decision-fork", "execution-checkpoint"].includes(trigger)) {
        throw new Error("--trigger must be steward-request, goal-review, decision-fork, or execution-checkpoint");
      }
      const subjectRevision = Number(option(args, "--subject-revision", "1"));
      if (!Number.isInteger(subjectRevision) || subjectRevision < 1) {
        throw new Error("--subject-revision must be a positive integer");
      }
      const context = await optionalJsonInput(args, "--context", "--context-file");
      if (context !== undefined && (!context || typeof context !== "object" || Array.isArray(context))) {
        throw new Error("clarification context must be a JSON object");
      }
      const signals = await optionalJsonInput(args, "--signals", "--signals-file");
      if (signals !== undefined && !Array.isArray(signals)) {
        throw new Error("clarification signals must be a JSON array");
      }
      print(await clarification.assess({
        trigger: trigger as import("./clarification.js").ClarificationAssessmentInput["trigger"],
        subject: {
          kind: required(args, "--subject-kind"),
          id: required(args, "--subject-id"),
          revision: subjectRevision,
        },
        intent: required(args, "--intent"),
        ...(context ? { context: context as JsonObject } : {}),
        ...(signals ? { signals: signals as import("./clarification.js").AmbiguitySignal[] } : {}),
      }));
      return 0;
    }
    if (command === "clarification" && args[1] === "status") {
      const session = clarification.get(required(args, "--run"));
      const questionFormat = option(args, "--question-format");
      if (questionFormat && questionFormat !== "chat" && questionFormat !== "cli") {
        throw new Error("--question-format must be chat or cli");
      }
      if (questionFormat && session.questionSheet) {
        const profile = questionFormat === "chat"
          ? questionRenderer.CHAT_MARKDOWN_PROFILE
          : questionRenderer.CLI_COMPACT_PROFILE;
        process.stdout.write(questionRenderer.renderQuestionSheet(session.questionSheet, profile).text);
      } else {
        print(session);
      }
      return 0;
    }
    if (command === "clarification" && args[1] === "list") {
      print(clarification.list());
      return 0;
    }
    if (command === "clarification" && args[1] === "respond") {
      const response = await questionResponse(args);
      if (!response) {
        throw new Error("clarification respond requires --answers-file, --accept-recommended, or --skip-questions");
      }
      print(await clarification.respond(required(args, "--run"), response));
      return 0;
    }
    if (command === "run") {
      const steward = new StewardService(runtime);
      const proposal = steward.prepare(required(args, "--request"));
      const applied = await steward.apply(proposal, option(args, "--approve-by"));
      print(steward.taskCard(proposal, applied));
      return 0;
    }
    if (command === "project" && args[1] === "plan") {
      print(await projectManager.writeProjectPlanProjection(runtime));
      return 0;
    }
    if (command === "project" && args[1] === "status") {
      const plan = await projectManager.writeProjectPlanProjection(runtime);
      print({
        ...runtime.status(),
        state: plan.readiness.state,
        readiness: plan.readiness,
        plan,
      });
      return 0;
    }
    if (command === "goal" && args[1] === "create") {
      print(
        await runtime.createGoal(
          required(args, "--outcome"),
          option(args, "--actor", "human_001"),
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "decision" && args[1] === "create") {
      print(
        await runtime.createDecision(
          required(args, "--question"),
          required(args, "--choice"),
          required(args, "--reason"),
          required(args, "--affected").split(",").filter(Boolean),
          option(args, "--actor", runtime.ownerId())!,
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "task" && args[1] === "create") {
      print(
        await runtime.createTask(
          required(args, "--goal"),
          required(args, "--objective"),
          option(args, "--actor", "human_001"),
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "agent" && args[1] === "register") {
      print(
        await runtime.registerAgent(
          required(args, "--name"),
          option(args, "--host", "agent-native")!,
          option(args, "--actor", "human_001"),
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "dispatch") {
      print(
        await runtime.dispatch(
          required(args, "--task"),
          required(args, "--agent"),
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "callback") {
      const workReport = await optionalJsonInput(
        args,
        "--callback",
        "--callback-file",
      ) as JsonObject | undefined;
      const rawOutcome = (workReport?.outcome as string | undefined) ??
        option(args, "--outcome", "verified")!;
      if (!["verified", "partial", "blocked", "externalSignoffBlocked"].includes(rawOutcome)) {
        throw new Error(`invalid callback outcome ${rawOutcome}`);
      }
      const evidenceIds = workReport
        ? workReport.evidenceIds
        : (option(args, "--evidence", "") ?? "").split(",").filter(Boolean);
      if (!Array.isArray(evidenceIds) || evidenceIds.some((value) => typeof value !== "string")) {
        throw new Error("callback evidenceIds must be an array of strings");
      }
      print(
        await runtime.callback(
          required(args, "--assignment"),
          rawOutcome as "verified" | "partial" | "blocked" | "externalSignoffBlocked",
          evidenceIds as string[],
          option(args, "--command-id"),
          workReport,
        ),
      );
      return 0;
    }
    if (command === "verify") {
      const taskId = required(args, "--task");
      const assignmentId = required(args, "--assignment");
      const verificationPlan = await loadVerificationPlan(
        option(args, "--verification-file", join(projectRoot, ".pkr", "verification.json"))!,
      );
      const verificationEvidence = await runLocalVerification(
        projectRoot,
        taskId,
        assignmentId,
        verificationPlan,
      );
      print(
        await runtime.verify(
          taskId,
          assignmentId,
          option(args, "--actor", "agent_verifier"),
          option(args, "--command-id"),
          verificationEvidence,
        ),
      );
      return 0;
    }
    if (command === "events") {
      print(runtime.listEvents(Number(option(args, "--after", "0"))));
      return 0;
    }
    if (command === "workspace") {
      const repositoryEvidence = await collectRepositoryEvidence(projectRoot);
      print(
        runtime.workspace(
          required(args, "--task"),
          required(args, "--assignment"),
          required(args, "--principal"),
          repositoryEvidence as unknown as JsonObject,
        ),
      );
      return 0;
    }
    if (command === "memory" && args[1] === "derive") {
      print(
        await memory.derive(
          required(args, "--summary"),
          [{
            kind: required(args, "--source-kind"),
            id: required(args, "--source-id"),
            revision: Number(required(args, "--source-revision")),
          }],
          option(args, "--visibility", "project")!,
          option(args, "--actor", runtime.ownerId())!,
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "memory" && args[1] === "list") {
      print(
        await memory.retrieve(
          option(args, "--principal", runtime.ownerId())!,
          (option(args, "--roles", "") ?? "").split(",").filter(Boolean),
        ),
      );
      return 0;
    }
    if (command === "memory" && args[1] === "promote") {
      print(
        await memory.promote(
          required(args, "--memory"),
          required(args, "--title"),
          option(args, "--actor", runtime.ownerId())!,
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "profile" && args[1] === "install") {
      const name = required(args, "--name") as StarterProfileName;
      const profile = STARTER_PROFILES[name];
      if (!profile) {
        throw new Error(`unknown starter profile ${name}`);
      }
      print(
        await packages.installStarterProfile(
          name,
          required(args, "--decision"),
          (option(args, "--capabilities", profile.requestedCapabilities.join(",")) ?? "")
            .split(",")
            .filter(Boolean),
          option(args, "--actor", runtime.ownerId())!,
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "profile" && args[1] === "list") {
      print({
        available: Object.keys(STARTER_PROFILES),
        installations: runtime.listRecords("PackageInstallation"),
      });
      return 0;
    }
    if (command === "workflow" && args[1] === "start") {
      print(
        await runtime.startPortableWorkflow(
          required(args, "--workflow"),
          { type: "task", taskId: required(args, "--task") },
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "workflow" && args[1] === "transition") {
      print(
        await runtime.transitionPortableWorkflow(
          required(args, "--run"),
          required(args, "--to"),
          JSON.parse(required(args, "--context")) as JsonObject,
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "package" && args[1] === "uninstall") {
      print(
        await packages.uninstall(
          required(args, "--package"),
          option(args, "--actor", runtime.ownerId())!,
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "package" && args[1] === "rollback") {
      print(
        await packages.rollback(
          required(args, "--package"),
          required(args, "--target"),
          option(args, "--actor", runtime.ownerId())!,
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "prompt" && args[1] === "register") {
      print(
        await runtime.registerPrompt(
          required(args, "--title"),
          await textInput(args, "--template", "--template-file"),
          option(args, "--version", "1.0.0")!,
          option(args, "--actor", runtime.ownerId())!,
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "prompt" && args[1] === "status") {
      print(runtime.promptStatus(required(args, "--id")));
      return 0;
    }
    if (command === "prompt" && args[1] === "rollback") {
      print(
        await runtime.rollbackPrompt(
          required(args, "--current"),
          required(args, "--target"),
          option(args, "--actor", runtime.ownerId())!,
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "policy" && args[1] === "register") {
      print(
        await runtime.registerPolicy(
          await jsonInput(args, "--policy", "--policy-file") as GovernancePolicyContent,
          option(args, "--actor", runtime.ownerId())!,
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "policy" && args[1] === "status") {
      print(runtime.policyStatus(required(args, "--id")));
      return 0;
    }
    if (command === "policy" && args[1] === "rollback") {
      print(
        await runtime.rollbackPolicy(
          required(args, "--current"),
          required(args, "--target"),
          option(args, "--actor", runtime.ownerId())!,
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "adapter" && args[1] === "register") {
      print(
        await runtime.registerAdapter(
          await jsonInput(args, "--adapter", "--adapter-file") as ManagedAdapterContent,
          option(args, "--actor", runtime.ownerId())!,
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "adapter" && args[1] === "status") {
      print(runtime.adapterStatus(required(args, "--id")));
      return 0;
    }
    if (command === "adapter" && args[1] === "rollback") {
      print(
        await runtime.rollbackAdapter(
          required(args, "--current"),
          required(args, "--target"),
          option(args, "--actor", runtime.ownerId())!,
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "metric" && args[1] === "record") {
      const threshold: MetricThreshold = {
        operator: required(args, "--operator") as MetricThresholdOperator,
        value: scalarJson(args, "--threshold"),
        severity: option(args, "--severity", "warning") as MetricThreshold["severity"],
      };
      print(
        await runtime.recordMetric(
          required(args, "--measure"),
          required(args, "--source"),
          required(args, "--window"),
          threshold,
          scalarJson(args, "--value"),
          option(args, "--actor", runtime.ownerId())!,
          option(args, "--command-id"),
          JSON.parse(option(args, "--source-configuration", "{}")!) as JsonObject,
        ),
      );
      return 0;
    }
    if (command === "evolution" && args[1] === "propose") {
      print(
        await evolution.observeRepeatedFailures(
          await jsonInput(args, "--candidate", "--candidate-file") as EvolutionCandidateSpec,
          required(args, "--proposer"),
          Number(option(args, "--threshold", "2")),
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "evolution" && args[1] === "observe") {
      print(
        await evolution.observe(
          await jsonInput(args, "--candidate", "--candidate-file") as EvolutionCandidateSpec,
          await jsonInput(args, "--observation", "--observation-file") as EvolutionObservationSpec,
          required(args, "--proposer"),
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "evolution" && args[1] === "revise") {
      print(
        await evolution.revise(
          required(args, "--id"),
          await jsonInput(args, "--candidate", "--candidate-file") as EvolutionCandidateSpec,
          required(args, "--proposer"),
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "evolution" && args[1] === "approve") {
      print(
        await evolution.approve(
          required(args, "--id"),
          option(args, "--approver", runtime.ownerId())!,
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "evolution" && args[1] === "evaluate") {
      print(
        await evolution.evaluate(
          required(args, "--id"),
          required(args, "--verifier"),
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "evolution" && args[1] === "external-evaluate") {
      print(
        await evolution.evaluateExternally(
          required(args, "--id"),
          required(args, "--supervisor"),
          await jsonInput(args, "--result", "--result-file") as JsonObject,
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "evolution" && args[1] === "promote") {
      print(
        await evolution.promote(
          required(args, "--id"),
          option(args, "--promoter", runtime.ownerId())!,
          option(args, "--supervisor"),
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "evolution" && args[1] === "monitor") {
      print(
        await evolution.monitor(
          required(args, "--id"),
          required(args, "--observer"),
          scalarJson(args, "--value"),
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "evolution" && args[1] === "status") {
      print(evolution.status(required(args, "--id")));
      return 0;
    }
    if (command === "steward" && args[1] === "propose") {
      const proposal = await new StewardService(runtime).prepareWithClarification(required(args, "--request"));
      const questionFormat = option(args, "--question-format");
      if (questionFormat && questionFormat !== "chat" && questionFormat !== "cli") {
        throw new Error("--question-format must be chat or cli");
      }
      if (questionFormat && proposal.questionSheet) {
        const profile = questionFormat === "chat"
          ? questionRenderer.CHAT_MARKDOWN_PROFILE
          : questionRenderer.CLI_COMPACT_PROFILE;
        process.stdout.write(questionRenderer.renderQuestionSheet(proposal.questionSheet, profile).text);
      } else {
        print(proposal);
      }
      return 0;
    }
    if (command === "steward" && args[1] === "apply") {
      const steward = new StewardService(runtime);
      const proposal = steward.prepare(required(args, "--request"));
      print(await steward.apply(proposal, option(args, "--approve-by"), await questionResponse(args)));
      return 0;
    }
    if (command === "lps" && args[1] === "claim") {
      print(await lps.claim(
        required(args, "--task"),
        required(args, "--agent"),
        option(args, "--session-locator"),
      ));
      return 0;
    }
    if (command === "lps" && args[1] === "submit") {
      const supplied = await optionalJsonInput(args, "--result", "--result-file") as
        Partial<AgentNativeSubmission> | undefined;
      const outcome = option(args, "--outcome") as AgentNativeSubmission["outcome"] | undefined;
      print(await lps.submit(
        required(args, "--assignment"),
        required(args, "--agent"),
        outcome ? { ...supplied, outcome } : supplied,
      ));
      return 0;
    }
    if (command === "lps" && args[1] === "adapter-run") {
      const configuredProvider = await loadLocalProviderConfig(
        option(args, "--provider-file", join(projectRoot, ".pkr", "provider.json"))!,
      );
      print(
        await new LpsOrchestrator(runtime, configuredProvider).executeLane(
          required(args, "--task"),
          required(args, "--agent"),
        ),
      );
      return 0;
    }
    if (command === "lps" && args[1] === "board") {
      print(lps.board());
      return 0;
    }
    if (command === "supervise") {
      const once = args.includes("--once");
      const watch = args.includes("--watch");
      if (once === watch) {
        throw new Error("supervise requires exactly one of --once or --watch");
      }
      const interval = Number(option(args, "--interval", "1000"));
      if (!Number.isInteger(interval) || interval < 100 || interval > 600_000) {
        throw new Error("--interval must be an integer between 100 and 600000 milliseconds");
      }
      const supervisor = await SupervisorRunner.open(
        runtime,
        option(args, "--config", join(projectRoot, ".pkr", "supervisor.json"))!,
      );
      if (once) {
        const result = await supervisor.reconcile();
        print(result);
        return result.outcome === "attention" ? 2 : 0;
      }
      while (true) {
        const result = await supervisor.reconcile();
        process.stdout.write(`${JSON.stringify(result)}\n`);
        if (result.outcome === "attention") return 2;
        if (result.nextAction === "none") return 0;
        await new Promise<void>((resume) => setTimeout(resume, interval));
      }
    }
    if (command === "assignment" && args[1] === "cancel") {
      print(
        await lps.cancel(
          required(args, "--assignment"),
          option(args, "--reason", "CancelledByOwner")!,
        ),
      );
      return 0;
    }
    if (command === "lease" && args[1] === "heartbeat") {
      print(await lps.heartbeat(required(args, "--assignment")));
      return 0;
    }
    if (command === "lease" && args[1] === "expire") {
      print(await lps.expire(required(args, "--assignment")));
      return 0;
    }
    if (command === "digest") {
      print({ projectId: runtime.projectId, digest: runtime.stateDigest() });
      return 0;
    }
    if (command === "projection" && args[1] === "rebuild") {
      await runtime.rebuildProjections();
      print({ projectId: runtime.projectId, rebuilt: true });
      return 0;
    }
    if (command === "projection" && args[1] === "export") {
      const profile = required(args, "--profile");
      if (profile !== "shareable") {
        throw new Error("--profile must be shareable");
      }
      const outputPath = resolve(projectRoot, required(args, "--output"));
      const maxBytesOption = option(args, "--max-bytes");
      const maxBytes = maxBytesOption === undefined ? undefined : Number(maxBytesOption);
      if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 1)) {
        throw new Error("--max-bytes must be a positive integer");
      }
      const exported = await runtime.exportShareableProjection(
        outputPath,
        maxBytes === undefined ? {} : { maxBytes },
      );
      print({
        projectId: runtime.projectId,
        profile,
        outputPath,
        sourceStateDigest: exported.sourceStateDigest,
        digest: exported.digest,
        summary: exported.summary,
      });
      return 0;
    }
    throw new Error(
      "usage: pkr doctor|init|setup|run|status|diagnostics export|project intake|project bootstrap|project plan|project status|goal create|decision create|task create|agent register|dispatch|callback|verify|events|workspace|memory derive|memory list|memory promote|profile install|profile list|workflow start|workflow transition|package uninstall|package rollback|prompt register|prompt status|prompt rollback|policy register|policy status|policy rollback|adapter register|adapter status|adapter rollback|metric record|evolution propose|evolution observe|evolution revise|evolution approve|evolution evaluate|evolution external-evaluate|evolution promote|evolution monitor|evolution status|steward propose|steward apply|lps claim|lps submit|lps adapter-run|lps board|supervise|assignment cancel|lease heartbeat|lease expire|digest|projection rebuild|projection export",
    );
  } finally {
    runtime.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const payload = isPkrError(error)
      ? { code: error.code, status: error.status, message: error.message }
      : {
          code: "PKR-CLI-001",
          status: "rejected",
          message: error instanceof Error ? error.message : String(error),
        };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = 1;
  });
