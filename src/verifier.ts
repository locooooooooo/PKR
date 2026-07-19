import { resolve } from "node:path";

import { PkrError } from "./errors.js";
import { runBoundedProcess, type BoundedProcessResult } from "./process.js";
import type { JsonObject } from "./types.js";
import { digest } from "./util.js";
import { collectRepositoryEvidence, type RepositoryEvidence } from "./workspace.js";

export interface VerificationCommand {
  id: string;
  executable: string;
  args: string[];
  timeoutMs: number;
}

export interface VerificationPlan {
  version: "pkr.verify/v1";
  commands: VerificationCommand[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  requireChanges: boolean;
}

function normalizePattern(pattern: string): string {
  return pattern.replaceAll("\\", "/").replace(/^\.\//, "");
}

function validPattern(pattern: string): boolean {
  const normalized = normalizePattern(pattern);
  return normalized === "**" ||
    (!!normalized && !normalized.startsWith("/") && !normalized.includes("..") &&
      (!normalized.includes("*") || normalized.endsWith("/**")));
}

function matches(path: string, pattern: string): boolean {
  const normalized = normalizePattern(pattern);
  if (normalized === "**") {
    return true;
  }
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3).replace(/\/$/, "");
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === normalized;
}

export function validateVerificationPlan(plan: VerificationPlan): void {
  const commandIds = plan?.commands?.map((command) => command.id) ?? [];
  if (
    !plan ||
    plan.version !== "pkr.verify/v1" ||
    !Array.isArray(plan.commands) ||
    plan.commands.length === 0 ||
    new Set(commandIds).size !== commandIds.length ||
    plan.commands.some((command) =>
      !command ||
      !/^[a-z][a-z0-9._-]{0,63}$/.test(command.id) ||
      !command.executable?.trim() ||
      !Array.isArray(command.args) ||
      command.args.some((argument) => typeof argument !== "string") ||
      !Number.isInteger(command.timeoutMs) ||
      command.timeoutMs < 100 ||
      command.timeoutMs > 600_000
    ) ||
    !Array.isArray(plan.allowedPaths) ||
    plan.allowedPaths.length === 0 ||
    plan.allowedPaths.some((pattern) => typeof pattern !== "string" || !validPattern(pattern)) ||
    !Array.isArray(plan.forbiddenPaths) ||
    plan.forbiddenPaths.some((pattern) => typeof pattern !== "string" || !validPattern(pattern)) ||
    typeof plan.requireChanges !== "boolean"
  ) {
    throw new PkrError(
      "PKR-VERIFY-001",
      "verification plan requires bounded commands and repository-relative path rules",
    );
  }
}

export function shellVerificationPlan(
  command: string,
  timeoutMs = 10 * 60 * 1000,
): VerificationPlan {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new PkrError("PKR-VERIFY-001", "verification command must not be empty");
  }
  const plan: VerificationPlan = {
    version: "pkr.verify/v1",
    commands: [{
      id: "repository-check",
      executable: process.platform === "win32"
        ? process.env.ComSpec ?? "cmd.exe"
        : "/bin/sh",
      args: process.platform === "win32"
        ? ["/d", "/s", "/c", trimmed]
        : ["-lc", trimmed],
      timeoutMs,
    }],
    allowedPaths: ["**"],
    forbiddenPaths: [".pkr/**"],
    requireChanges: true,
  };
  validateVerificationPlan(plan);
  return plan;
}

function processEvidence(result: BoundedProcessResult): JsonObject {
  return result as unknown as JsonObject;
}

export async function runLocalVerification(
  projectRoot: string,
  taskId: string,
  assignmentId: string,
  plan: VerificationPlan,
): Promise<JsonObject> {
  validateVerificationPlan(plan);
  const commandResults: JsonObject[] = [];
  for (const command of plan.commands) {
    const result = await runBoundedProcess({
      executable: command.executable,
      args: command.args,
      cwd: resolve(projectRoot),
      timeoutMs: command.timeoutMs,
      maxOutputBytes: 256 * 1024,
    });
    commandResults.push({ id: command.id, ...processEvidence(result) });
  }
  const repository = await collectRepositoryEvidence(projectRoot);
  const outsideAllowed = repository.changedFiles.filter((path) =>
    !plan.allowedPaths.some((pattern) => matches(path, pattern)),
  );
  const forbidden = repository.changedFiles.filter((path) =>
    plan.forbiddenPaths.some((pattern) => matches(path, pattern)),
  );
  const scopePassed = outsideAllowed.length === 0 && forbidden.length === 0 &&
    (!plan.requireChanges || repository.changedFiles.length > 0);
  const commandsPassed = commandResults.every((result) =>
    result.exitCode === 0 && result.timedOut === false && result.failureReason === null,
  );
  const passed = scopePassed && commandsPassed;
  const reason = !scopePassed
    ? "RepositoryScopeFailed"
    : !commandsPassed ? "VerificationCommandFailed" : "VerificationPassed";
  const content: JsonObject = {
    adapter: "pkr.local-verifier/v1",
    taskId,
    assignmentId,
    plan: plan as unknown as JsonObject,
    planDigest: digest(plan),
    repository: repository as unknown as JsonObject,
    scope: {
      passed: scopePassed,
      requireChanges: plan.requireChanges,
      allowedPaths: plan.allowedPaths,
      forbiddenPaths: plan.forbiddenPaths,
      outsideAllowed,
      forbidden,
    },
    commands: commandResults,
    passed,
    reason,
    completedAt: new Date().toISOString(),
  };
  return { ...content, digest: digest(content) };
}

export type { RepositoryEvidence };
