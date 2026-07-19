#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isPkrError } from "./errors.js";
import type { StarterProfileName } from "./profiles.js";
import type { PkrRuntime } from "./runtime.js";
import type { InitOptions, JsonObject } from "./types.js";
import { derivedId } from "./util.js";
import { runLocalVerification, shellVerificationPlan } from "./verifier.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const COMMAND_OPTIONS: Record<string, Set<string>> = {
  init: new Set(["--name", "--title", "--outcome", "--description", "--authority", "--command-id", "--project", "--help"]),
  run: new Set(["--verify", "--model", "--reasoning", "--approve", "--request", "--project", "--help"]),
  status: new Set(["--project", "--help"]),
  goal: new Set(["--outcome", "--actor", "--command-id", "--project", "--help"]),
  decision: new Set(["--question", "--choice", "--reason", "--affected", "--actor", "--command-id", "--project", "--help"]),
  task: new Set(["--goal", "--objective", "--actor", "--command-id", "--project", "--help"]),
  agent: new Set(["--name", "--provider", "--actor", "--command-id", "--project", "--help"]),
  dispatch: new Set(["--task", "--agent", "--command-id", "--project", "--help"]),
  callback: new Set(["--assignment", "--outcome", "--evidence", "--command-id", "--project", "--help"]),
  verify: new Set(["--task", "--assignment", "--actor", "--command-id", "--evidence-file", "--project", "--help"]),
  events: new Set(["--after", "--project", "--help"]),
  workspace: new Set(["--task", "--assignment", "--principal", "--project", "--help"]),
  memory: new Set(["--summary", "--source-kind", "--source-id", "--source-revision", "--visibility", "--principal", "--roles", "--memory", "--title", "--actor", "--command-id", "--project", "--help"]),
  profile: new Set(["--name", "--decision", "--capabilities", "--actor", "--command-id", "--project", "--help"]),
  workflow: new Set(["--workflow", "--task", "--run", "--to", "--context", "--command-id", "--project", "--help"]),
  package: new Set(["--package", "--target", "--actor", "--command-id", "--project", "--help"]),
  steward: new Set(["--request", "--approve-by", "--project", "--help"]),
  lps: new Set(["--task", "--agent", "--project", "--help"]),
  assignment: new Set(["--assignment", "--reason", "--project", "--help"]),
  lease: new Set(["--assignment", "--project", "--help"]),
  digest: new Set(["--project", "--help"]),
  projection: new Set(["--project", "--help"]),
};

const OPTIONS_WITH_VALUES = new Set([
  "--name", "--title", "--outcome", "--description", "--authority", "--command-id",
  "--verify", "--model", "--reasoning", "--request", "--question", "--choice", "--reason",
  "--affected", "--actor", "--goal", "--objective", "--provider", "--task", "--agent",
  "--assignment", "--evidence", "--evidence-file", "--after", "--principal", "--source-kind",
  "--source-id", "--source-revision", "--visibility", "--roles", "--memory", "--decision",
  "--capabilities", "--workflow", "--run", "--to", "--context", "--package", "--target",
  "--approve-by", "--description", "--project",
]);

const HELP_TEXT: Record<string, string> = {
  root: `PKR local authoritative Runtime\n\nUsage:\n  pkr init [options]\n  pkr run "<task>" [--verify "<command>"] [options]\n  pkr status [--project <path>]\n\nCommands:\n  init       initialize .pkr state in a Git repository\n  run        execute one Provider step, independent verification, and status\n  status     reopen and report persisted project state\n\nAdvanced commands: goal, decision, task, agent, dispatch, callback, verify, events, workspace, memory, profile, workflow, package, steward, lps, assignment, lease, digest, projection`,
  init: "Usage: pkr init [--project <path>] [--name <name>] [--title <title>] [--outcome <outcome>]",
  run: "Usage: pkr run \"<task>\" [--project <path>] [--verify \"<command>\"] [--model <model>] [--reasoning <level>] [--approve]",
  status: "Usage: pkr status [--project <path>]",
  verify: "Usage: pkr verify --task <task-id> --assignment <assignment-id> --evidence-file <path> [--actor <id>]",
};

function preflight(args: string[]): { command?: string; help?: string } {
  const command = args[0];
  if (!command || command === "--help" || command === "help") {
    if (command && command !== "--help" && command !== "help") {
      throw new Error(`unknown command ${command}`);
    }
    return { help: HELP_TEXT.root! };
  }
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) {
    throw new Error(`unknown command ${command}`);
  }
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      continue;
    }
    if (!allowed.has(token)) {
      throw new Error(`unknown option ${token} for command ${command}`);
    }
    if (OPTIONS_WITH_VALUES.has(token) && (!args[index + 1] || args[index + 1]!.startsWith("--"))) {
      throw new Error(`option ${token} requires a value`);
    }
    if (OPTIONS_WITH_VALUES.has(token)) {
      index += 1;
    }
  }
  if (args.includes("--help")) {
    const help = HELP_TEXT[command] ?? `Usage: pkr ${command} [options]`;
    return { command, help };
  }
  return { command };
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

function positionalRequest(args: string[]): string | undefined {
  const value = args[1];
  return value && !value.startsWith("--") ? value : option(args, "--request");
}

function operationalStatus(runtime: PkrRuntime): JsonObject {
  const status = runtime.status();
  const tasks = runtime.listRecords("Task").map((record) => ({
    id: record.id,
    objective: (record.data.spec as JsonObject).objective as string,
    phase: (record.data.status as JsonObject).phase as string,
    reason: (record.data.status as JsonObject).reason as string,
    revision: record.revision,
    updatedAt: record.updatedAt,
  }));
  const assignments = runtime.listRecords("Assignment").map((record) => ({
    id: record.id,
    taskId: record.data.taskId as string,
    state: record.data.state as string,
    outcome: (record.data.disposition as string | null) ?? null,
    revision: record.revision,
    updatedAt: record.updatedAt,
  }));
  const callbacks = runtime.listRecords("AgentMessage").map((record) => ({
    id: record.id,
    assignmentId: record.data.assignmentId as string,
    issuedAt: record.data.issuedAt as string,
    ...(record.data.payload as JsonObject),
  }));
  const completed = tasks.filter((task) => task.phase === "done").length;
  const blocked = tasks.filter((task) => task.phase === "blocked").length;
  return {
    ...status,
    summary: {
      state: blocked > 0 ? "attentionRequired" : completed > 0 ? "completed" : "ready",
      totalTasks: tasks.length,
      completedTasks: completed,
      blockedTasks: blocked,
      persisted: true,
    },
    tasks,
    assignments,
    callbacks,
    recentEvents: runtime.listEvents().slice(-10).map((event) => ({
      projectId: event.projectId,
      sequence: event.sequence,
      eventId: event.eventId,
      type: event.type,
      subjectKind: event.subjectKind,
      subjectId: event.subjectId,
      subjectRevision: event.subjectRevision,
      commandId: event.commandId,
      occurredAt: event.occurredAt,
      data: event.data,
    })),
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const preflightResult = preflight(args);
  if (preflightResult.help) {
    process.stdout.write(`${preflightResult.help}\n`);
    return 0;
  }
  const projectRoot = resolve(option(args, "--project", process.cwd())!);
  const command = preflightResult.command;
  const [
    { CodexCliAdapter },
    { LpsOrchestrator },
    { MemoryService },
    { PackageService },
    { STARTER_PROFILES },
    { LocalProcessAdapter },
    { PkrRuntime },
    { StewardService },
  ] = await Promise.all([
    import("./codex.js"),
    import("./lps.js"),
    import("./memory.js"),
    import("./packages.js"),
    import("./profiles.js"),
    import("./provider.js"),
    import("./runtime.js"),
    import("./steward.js"),
  ]);

  if (command === "init") {
    const name = option(args, "--name", basename(projectRoot))!;
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

  const runtime = await PkrRuntime.open(projectRoot, repositoryRoot);
  try {
    const provider = new LocalProcessAdapter(
      process.execPath,
      resolve(repositoryRoot, "dist", "provider-worker.js"),
    );
    const lps = new LpsOrchestrator(runtime, provider);
    const memory = new MemoryService(runtime);
    const packages = new PackageService(runtime);
    if (command === "status") {
      print(operationalStatus(runtime));
      return 0;
    }
    if (command === "run") {
      const request = positionalRequest(args);
      if (!request) {
        throw new Error('usage: pkr run "<task>" [--verify "<command>"] [--approve]');
      }
      const steward = new StewardService(runtime);
      const proposal = steward.prepare(request);
      const approvedBy = args.includes("--approve") ? runtime.ownerId() : undefined;
      const intake = await steward.apply(proposal, approvedBy);
      const agent = await runtime.registerAgent(
        "codex-cli",
        "codex-cli",
        runtime.ownerId(),
        derivedId("command", `${runtime.projectId}:codex-cli-agent`),
      );
      const agentId = ((agent.value as JsonObject).metadata as JsonObject).id as string;
      const verificationCommand = option(args, "--verify", "npm test")!;
      const adapter = new CodexCliAdapter({
        projectRoot,
        request,
        ...(option(args, "--model") ? { model: option(args, "--model")! } : {}),
        ...(option(args, "--reasoning")
          ? {
              reasoningEffort: option(args, "--reasoning") as
                | "low"
                | "medium"
                | "high"
                | "xhigh",
            }
          : {}),
        ...(process.env.PKR_CODEX_COMMAND
          ? { executable: process.env.PKR_CODEX_COMMAND }
          : {}),
        ...(process.env.PKR_CODEX_ARGS
          ? { executableArgs: JSON.parse(process.env.PKR_CODEX_ARGS) as string[] }
          : {}),
      });
      const result = await new LpsOrchestrator(runtime, adapter).executeLane(
        intake.taskId as string,
        agentId,
      );
      let verification: JsonObject | null = null;
      const task = runtime.getRecord("Task", intake.taskId as string);
      if ((task.data.status as JsonObject).phase === "verifying") {
        const evidence = await runLocalVerification(
          projectRoot,
          intake.taskId as string,
          result.assignmentId,
          shellVerificationPlan(verificationCommand),
        );
        const runDirectory = resolve(projectRoot, ".pkr", "runs", result.assignmentId);
        await mkdir(runDirectory, { recursive: true });
        await writeFile(
          resolve(runDirectory, "verification.json"),
          `${JSON.stringify(evidence, null, 2)}\n`,
          "utf8",
        );
        const commandEvidence = (evidence.commands as JsonObject[])[0]!;
        await writeFile(
          resolve(runDirectory, "verification.log"),
          [
            `$ ${verificationCommand}`,
            commandEvidence.stdout as string,
            commandEvidence.stderr as string,
            `exit=${commandEvidence.exitCode as number | null} timedOut=${commandEvidence.timedOut as boolean}`,
          ].join("\n"),
          "utf8",
        );
        const accepted = await runtime.verify(
          intake.taskId as string,
          result.assignmentId,
          "agent_repository_verifier",
          derivedId("command", `pkr-run:${result.assignmentId}:repository-verify`),
          evidence,
        );
        verification = accepted.value as JsonObject;
      }
      print({
        command: "run",
        provider: { id: adapter.id, version: adapter.version },
        intake,
        execution: result,
        verification,
        status: operationalStatus(runtime),
      });
      return verification?.passed === true ||
          (runtime.getRecord("Task", intake.taskId as string).data.status as JsonObject).phase === "done"
        ? 0
        : 2;
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
          option(args, "--provider", "local")!,
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
      const rawOutcome = option(args, "--outcome", "partial")!;
      if (!["verified", "partial", "blocked", "externalSignoffBlocked"].includes(rawOutcome)) {
        throw new Error(`invalid callback outcome ${rawOutcome}`);
      }
      print(
        await runtime.callback(
          required(args, "--assignment"),
          rawOutcome as "verified" | "partial" | "blocked" | "externalSignoffBlocked",
          (option(args, "--evidence", "") ?? "").split(",").filter(Boolean),
          option(args, "--command-id"),
        ),
      );
      return 0;
    }
    if (command === "verify") {
      const evidence = JSON.parse(
        await readFile(required(args, "--evidence-file"), "utf8"),
      ) as JsonObject;
      print(
        await runtime.verify(
          required(args, "--task"),
          required(args, "--assignment"),
          option(args, "--actor", "agent_verifier"),
          option(args, "--command-id"),
          evidence,
        ),
      );
      return 0;
    }
    if (command === "events") {
      print(runtime.listEvents(Number(option(args, "--after", "0"))));
      return 0;
    }
    if (command === "workspace") {
      print(
        runtime.workspace(
          required(args, "--task"),
          required(args, "--assignment"),
          required(args, "--principal"),
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
    if (command === "steward" && args[1] === "propose") {
      print(new StewardService(runtime).prepare(required(args, "--request")));
      return 0;
    }
    if (command === "steward" && args[1] === "apply") {
      const steward = new StewardService(runtime);
      const proposal = steward.prepare(required(args, "--request"));
      print(await steward.apply(proposal, option(args, "--approve-by")));
      return 0;
    }
    if (command === "lps" && args[1] === "run") {
      print(
        await lps.executeLane(
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
    throw new Error(
      "usage: pkr init|run|status (advanced: goal|decision|task|agent|dispatch|callback|verify|events|workspace|memory|profile|workflow|package|steward|lps|assignment|lease|digest|projection)",
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
