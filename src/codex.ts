import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PkrError } from "./errors.js";
import type {
  AgentProviderAdapter,
  ProviderCallback,
  ProviderExecutionRequest,
} from "./provider.js";
import type { JsonObject } from "./types.js";
import { sha256 } from "./util.js";

const DEFAULT_CODEX_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CodexCliAdapterOptions {
  projectRoot: string;
  request: string;
  verificationCommand: string;
  executable?: string;
  executableArgs?: string[];
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  timeoutMs?: number;
  verificationTimeoutMs?: number;
}

interface AgentReport extends JsonObject {
  completed: string[];
  incomplete: string[];
  blockers: string[];
  nextAction: string;
}

export class CodexCliAdapter implements AgentProviderAdapter {
  readonly id = "pkr.adapter.codex-cli";
  readonly version = "0.7.0";
  readonly capabilities = ["filesystem.read", "filesystem.write", "terminal"] as const;

  constructor(private readonly options: CodexCliAdapterOptions) {}

  async execute(request: ProviderExecutionRequest): Promise<ProviderCallback> {
    const runDirectory = join(
      this.options.projectRoot,
      ".pkr",
      "runs",
      request.assignmentId,
    );
    await mkdir(runDirectory, { recursive: true });
    const schemaPath = join(runDirectory, "agent-report.schema.json");
    const lastMessagePath = join(runDirectory, "agent-report.json");
    await writeFile(schemaPath, `${JSON.stringify(agentReportSchema(), null, 2)}\n`, "utf8");

    const before = await gitSnapshot(this.options.projectRoot);
    const executable = this.options.executable ?? defaultCodexExecutable();
    const codexArgs = [
      ...(this.options.executableArgs ?? []),
      "exec",
      "--json",
      "--full-auto",
      "--ephemeral",
      ...(this.options.model ? ["--model", this.options.model] : []),
      ...(this.options.reasoningEffort
        ? ["-c", `model_reasoning_effort=\"${this.options.reasoningEffort}\"`]
        : []),
      "-C",
      this.options.projectRoot,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      lastMessagePath,
      "-",
    ];
    const prompt = buildPrompt(this.options.request, request.assignmentId);
    const codex = await runProcess(
      ...codexProcessSpec(executable, codexArgs),
      this.options.projectRoot,
      prompt,
      this.options.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS,
    );
    await writeFile(join(runDirectory, "codex.jsonl"), codex.stdout, "utf8");
    await writeFile(join(runDirectory, "codex.stderr.log"), codex.stderr, "utf8");

    const after = await gitSnapshot(this.options.projectRoot);
    const changed = before.digest !== after.digest;
    const report = await readAgentReport(lastMessagePath);
    if (codex.code !== 0 || codex.timedOut || !report) {
      return this.finish(runDirectory, request, {
        outcome: "blocked",
        completed: report?.completed ?? [],
        incomplete: report?.incomplete ?? ["agent-execution"],
        blockers: [
          codex.timedOut
            ? "Codex CLI timed out"
            : `Codex CLI exited with ${codex.code ?? "no exit code"}`,
        ],
        evidenceIds: evidenceIds(request.assignmentId, before, after, undefined),
        nextAction: report?.nextAction ?? "inspect the Codex execution log and retry with a new Task",
      }, before, after, undefined);
    }

    if (!changed) {
      return this.finish(runDirectory, request, {
        outcome: "partial",
        completed: report.completed,
        incomplete: [...report.incomplete, "source-change"],
        blockers: [...report.blockers, "Codex completed without a repository change"],
        evidenceIds: evidenceIds(request.assignmentId, before, after, undefined),
        nextAction: report.nextAction || "create a replacement Task with a concrete code change",
      }, before, after, undefined);
    }

    const verification = await runShellCommand(
      this.options.verificationCommand,
      this.options.projectRoot,
      this.options.verificationTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    );
    const verificationLog = [
      `$ ${this.options.verificationCommand}`,
      verification.stdout,
      verification.stderr,
      `exit=${verification.code ?? "none"} timedOut=${verification.timedOut}`,
    ].join("\n");
    await writeFile(join(runDirectory, "verification.log"), verificationLog, "utf8");
    const verificationDigest = `sha256:${sha256(verificationLog)}`;
    const passed = verification.code === 0 && !verification.timedOut;
    const remainingIncomplete = report.incomplete.filter(
      (item) => !/\b(test|tests|verification|verify)\b/i.test(item),
    );
    const verified = passed && report.blockers.length === 0 && remainingIncomplete.length === 0;
    return this.finish(runDirectory, request, {
      outcome: verified ? "verified" : passed ? "partial" : "blocked",
      completed: passed
        ? [...report.completed, "agent-change-recorded", "independent-tests-passed"]
        : [...report.completed, "agent-change-recorded"],
      incomplete: passed ? remainingIncomplete : [...report.incomplete, "independent-tests"],
      blockers: passed
        ? report.blockers
        : [
            ...report.blockers,
            verification.timedOut
              ? "Independent verification timed out"
              : `Independent verification exited with ${verification.code ?? "no exit code"}`,
          ],
      evidenceIds: evidenceIds(request.assignmentId, before, after, verificationDigest),
      nextAction: verified
        ? "restart PKR and inspect pkr status"
        : passed
          ? "complete the Agent-reported incomplete work in a replacement Task"
          : "fix the independent verification failure in a replacement Task",
    }, before, after, {
      command: this.options.verificationCommand,
      digest: verificationDigest,
      exitCode: verification.code,
      passed,
      timedOut: verification.timedOut,
    });
  }

  private async finish(
    runDirectory: string,
    request: ProviderExecutionRequest,
    callback: ProviderCallback,
    before: JsonObject,
    after: JsonObject,
    verification: JsonObject | undefined,
  ): Promise<ProviderCallback> {
    await writeFile(
      join(runDirectory, "summary.json"),
      `${JSON.stringify({
        apiVersion: "pkr.dev/v0.7",
        kind: "ProviderRunEvidence",
        assignmentId: request.assignmentId,
        sessionId: request.sessionId,
        provider: { id: this.id, version: this.version },
        callback,
        repository: { before, after, changed: before.digest !== after.digest },
        verification: verification ?? null,
      }, null, 2)}\n`,
      "utf8",
    );
    return callback;
  }
}

function buildPrompt(request: string, assignmentId: string): string {
  return [
    "You are the implementation agent for one PKR-governed Task.",
    `Task: ${request}`,
    `PKR Assignment: ${assignmentId}`,
    "Work only in the current Git repository. Make the smallest complete code change.",
    "Do not edit .pkr/**. Do not claim tests passed unless you ran them yourself.",
    "Do not run tests in this Agent session; PKR will run verification in a separate process.",
    "On Windows, if apply_patch fails once, use a direct shell file write and continue; do not diagnose the helper.",
    "Stop immediately after the scoped source change and return the final report.",
    "Return only the JSON object required by the provided output schema.",
  ].join("\n");
}

function agentReportSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["completed", "incomplete", "blockers", "nextAction"],
    properties: {
      completed: { type: "array", items: { type: "string" } },
      incomplete: { type: "array", items: { type: "string" } },
      blockers: { type: "array", items: { type: "string" } },
      nextAction: { type: "string" },
    },
  };
}

async function readAgentReport(path: string): Promise<AgentReport | undefined> {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<AgentReport>;
    if (
      !Array.isArray(value.completed) ||
      !Array.isArray(value.incomplete) ||
      !Array.isArray(value.blockers) ||
      typeof value.nextAction !== "string"
    ) {
      return undefined;
    }
    return value as AgentReport;
  } catch {
    return undefined;
  }
}

async function gitSnapshot(root: string): Promise<JsonObject> {
  const status = await runProcess(
    "git",
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude).pkr",
      ":(exclude).pkr/**",
    ],
    root,
    undefined,
    30_000,
  );
  if (status.code !== 0) {
    throw new PkrError("PKR-COORD-006", "pkr run requires a Git repository");
  }
  const diff = await runProcess(
    "git",
    ["diff", "--binary", "HEAD", "--", ".", ":(exclude).pkr", ":(exclude).pkr/**"],
    root,
    undefined,
    30_000,
  );
  const content = `${status.stdout}\n${diff.stdout}`;
  return {
    digest: `sha256:${sha256(content)}`,
    statusDigest: `sha256:${sha256(status.stdout)}`,
    diffDigest: `sha256:${sha256(diff.stdout)}`,
    changedPaths: status.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3)),
  };
}

function evidenceIds(
  assignmentId: string,
  before: JsonObject,
  after: JsonObject,
  verificationDigest: string | undefined,
): string[] {
  return [
    `pkr://runs/${assignmentId}/codex`,
    `pkr://runs/${assignmentId}/repository/${after.digest as string}`,
    ...(before.digest !== after.digest
      ? [`pkr://runs/${assignmentId}/change/${after.diffDigest as string}`]
      : []),
    ...(verificationDigest
      ? [`pkr://runs/${assignmentId}/verification/${verificationDigest}`]
      : []),
  ];
}

function defaultCodexExecutable(): string {
  const configured = process.env.PKR_CODEX_COMMAND;
  if (configured) {
    return configured;
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    const command = join(process.env.APPDATA, "npm", "codex.cmd");
    if (existsSync(command)) {
      return command;
    }
    return "codex.cmd";
  }
  return "codex";
}

function codexProcessSpec(executable: string, args: string[]): [string, string[]] {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(executable)) {
    return [executable, args];
  }
  const quote = (value: string): string => {
    if (/^[A-Za-z]:\\[^\s]*\.cmd$/i.test(value)) {
      return value;
    }
    if (/^[A-Za-z0-9_./:=+\\-]+$/.test(value)) {
      return value;
    }
    return `"${value.replaceAll('"', '\\"')}"`;
  };
  const command = [executable, ...args].map(quote).join(" ");
  return [process.env.ComSpec ?? "cmd.exe", ["/d", "/c", command]];
}

async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  if (process.platform === "win32") {
    return runProcess(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", command],
      cwd,
      undefined,
      timeoutMs,
    );
  }
  return runProcess("/bin/sh", ["-lc", command], cwd, undefined, timeoutMs);
}

function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  input: string | undefined,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current) >= MAX_CAPTURE_BYTES) {
        return current;
      }
      return current + chunk.toString("utf8");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new PkrError("PKR-COORD-006", `failed to start ${executable}: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    child.stdin.end(input);
  });
}
