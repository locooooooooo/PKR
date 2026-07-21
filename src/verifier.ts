import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { PkrError } from "./errors.js";
import { runBoundedProcess, type BoundedProcessResult } from "./process.js";
import { sanitizeProcessResult } from "./security.js";
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
  mode?: "configured" | "unconfigured";
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
    (plan.mode !== undefined && plan.mode !== "configured" && plan.mode !== "unconfigured") ||
    !Array.isArray(plan.commands) ||
    plan.commands.length === 0 ||
    new Set(commandIds).size !== commandIds.length ||
    plan.commands.some((command) =>
      !command ||
      !/^[a-z][a-z0-9._-]{0,63}$/.test(command.id) ||
      !command.executable?.trim() ||
      !Array.isArray(command.args) ||
      command.args.length > 128 ||
      command.args.some((argument) =>
        typeof argument !== "string" || Buffer.byteLength(argument, "utf8") > 64 * 1024
      ) ||
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

export async function loadVerificationPlan(path: string): Promise<VerificationPlan> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    throw new PkrError(
      "PKR-VERIFY-001",
      `cannot load verification plan ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const plan = parsed as VerificationPlan;
  validateVerificationPlan(plan);
  return plan;
}

function processEvidence(result: BoundedProcessResult): JsonObject {
  return sanitizeProcessResult(result) as unknown as JsonObject;
}

export async function runLocalVerification(
  projectRoot: string,
  taskId: string,
  assignmentId: string,
  plan: VerificationPlan,
): Promise<JsonObject> {
  validateVerificationPlan(plan);
  const repository = await collectRepositoryEvidence(projectRoot);
  const outsideAllowed = repository.changedFiles.filter((path) =>
    !plan.allowedPaths.some((pattern) => matches(path, pattern)),
  );
  const forbidden = repository.changedFiles.filter((path) =>
    plan.forbiddenPaths.some((pattern) => matches(path, pattern)),
  );
  const commandResults: JsonObject[] = [];
  for (const command of plan.commands) {
    const result = await runBoundedProcess({
      executable: command.executable,
      args: command.args,
      cwd: projectRoot,
      timeoutMs: command.timeoutMs,
      maxOutputBytes: 256 * 1024,
    });
    commandResults.push({ id: command.id, ...processEvidence(result) });
  }
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
