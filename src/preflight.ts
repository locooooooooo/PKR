import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

import { PkrError, isPkrError } from "./errors.js";
import { readLocalProviderConfig, type LocalProviderConfig } from "./provider.js";
import { PkrRuntime } from "./runtime.js";
import type { JsonObject } from "./types.js";
import { loadVerificationPlan, type VerificationPlan } from "./verifier.js";
import { collectRepositoryEvidence } from "./workspace.js";

export interface RepositoryPreflightOptions {
  providerFile?: string;
  verificationFile: string;
  adapter?: boolean;
}

export interface PreflightCheck {
  id: string;
  status: "pass" | "fail" | "blocked";
  code: string;
  message: string;
  details?: JsonObject;
}

export interface RepositoryPreflightReport {
  version: "pkr.preflight/v1";
  projectRoot: string;
  ready: boolean;
  checks: PreflightCheck[];
}

function pass(id: string, message: string, details?: JsonObject): PreflightCheck {
  return { id, status: "pass", code: "PKR-PREFLIGHT-OK", message, ...(details ? { details } : {}) };
}

function fail(id: string, fallbackCode: string, error: unknown): PreflightCheck {
  return {
    id,
    status: "fail",
    code: isPkrError(error) ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

function blocked(id: string, dependency: string): PreflightCheck {
  return {
    id,
    status: "blocked",
    code: "PKR-PREFLIGHT-DEPENDENCY",
    message: `${id} requires passing ${dependency}`,
  };
}

async function executableFile(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) {
      return false;
    }
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveConfiguredExecutable(
  executable: string,
  projectRoot: string,
): Promise<string> {
  const pathLike = isAbsolute(executable) || executable.includes("/") || executable.includes("\\");
  if (pathLike) {
    const candidate = isAbsolute(executable) ? executable : resolve(projectRoot, executable);
    if (await executableFile(candidate)) {
      return candidate;
    }
    throw new Error(`configured executable was not found: ${candidate}`);
  }

  const pathEntries = (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const extensions = process.platform === "win32" && !extname(executable)
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter(Boolean)
    : [""];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(directory, `${executable}${extension}`);
      if (await executableFile(candidate)) {
        return resolve(candidate);
      }
    }
  }
  throw new Error(`configured executable is not resolvable from PATH: ${executable}`);
}

export async function runRepositoryPreflight(
  projectRoot: string,
  repositoryRoot: string,
  options: RepositoryPreflightOptions,
): Promise<RepositoryPreflightReport> {
  const root = resolve(projectRoot);
  const checks: PreflightCheck[] = [];
  let runtime: PkrRuntime | undefined;
  let providerConfig: LocalProviderConfig | undefined;
  let verificationPlan: VerificationPlan | undefined;

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(nodeMajor >= 24
    ? pass("node", `Node ${process.versions.node} satisfies >=24`, { version: process.versions.node })
    : {
        id: "node",
        status: "fail",
        code: "PKR-PREFLIGHT-NODE",
        message: `Node ${process.versions.node} does not satisfy >=24`,
      });

  try {
    const repository = await collectRepositoryEvidence(root);
    checks.push(pass("git", "Git repository root and HEAD are ready", {
      head: repository.head,
      clean: repository.clean,
      changedFiles: repository.changedFiles,
    }));
  } catch (error) {
    checks.push(fail("git", "PKR-PREFLIGHT-GIT", error));
  }

  try {
    runtime = await PkrRuntime.open(root, repositoryRoot);
    const status = runtime.status();
    checks.push(pass("runtime", "PKR Runtime state is initialized and readable", {
      projectId: status.projectId ?? null,
      projectSequence: status.projectSequence ?? null,
      stateDigest: status.stateDigest ?? null,
    }));
  } catch (error) {
    checks.push(fail("runtime", "PKR-PREFLIGHT-RUNTIME", error));
  }

  checks.push(runtime
    ? pass("agent-native", "Agent-native claim and submit are available without a Provider process", {
        executionMode: "pull",
        locatorAuthority: false,
      })
    : blocked("agent-native", "runtime"));

  if (options.adapter) {
    const providerFile = options.providerFile ?? join(root, ".pkr", "provider.json");
    try {
      providerConfig = await readLocalProviderConfig(providerFile);
      checks.push(pass("provider-config", "optional local Provider configuration is valid", {
        path: resolve(providerFile),
        adapterId: providerConfig.adapter.id,
        adapterVersion: providerConfig.adapter.version,
      }));
    } catch (error) {
      checks.push(fail("provider-config", "PKR-PREFLIGHT-PROVIDER", error));
    }

    if (providerConfig) {
      try {
        const executable = await resolveConfiguredExecutable(providerConfig.command.executable, root);
        checks.push(pass("provider-executable", "optional Provider executable is resolvable", {
          executable,
        }));
      } catch (error) {
        checks.push(fail("provider-executable", "PKR-PREFLIGHT-EXECUTABLE", error));
      }
    } else {
      checks.push(blocked("provider-executable", "provider-config"));
    }
  }

  try {
    const loadedVerificationPlan = await loadVerificationPlan(options.verificationFile);
    if (loadedVerificationPlan.mode === "unconfigured") {
      throw new PkrError(
        "PKR-VERIFY-001",
        "repository Verification is explicitly unconfigured and cannot accept work",
      );
    }
    verificationPlan = loadedVerificationPlan;
    checks.push(pass("verification-config", "repository Verification configuration is valid", {
      path: resolve(options.verificationFile),
      commandIds: verificationPlan.commands.map((command) => command.id),
    }));
  } catch (error) {
    checks.push(fail("verification-config", "PKR-PREFLIGHT-VERIFY", error));
  }

  if (verificationPlan) {
    try {
      const executables = await Promise.all(verificationPlan.commands.map(async (command) => ({
        id: command.id,
        executable: await resolveConfiguredExecutable(command.executable, root),
      })));
      checks.push(pass("verification-executables", "all Verification executables are resolvable", {
        executables: executables as unknown as JsonObject["executables"],
      }));
    } catch (error) {
      checks.push(fail("verification-executables", "PKR-PREFLIGHT-EXECUTABLE", error));
    }
  } else {
    checks.push(blocked("verification-executables", "verification-config"));
  }

  if (options.adapter) {
    if (runtime && providerConfig) {
      try {
        const binding = runtime.inspectProviderAdapterBinding(providerConfig.adapter);
        checks.push(pass("adapter-binding", "optional Provider binding matches the active Adapter contract", binding));
      } catch (error) {
        checks.push(fail("adapter-binding", "PKR-PREFLIGHT-ADAPTER", error));
      }
    } else {
      checks.push(blocked(
        "adapter-binding",
        runtime ? "provider-config" : providerConfig ? "runtime" : "runtime and provider-config",
      ));
    }
  }

  runtime?.close();
  return {
    version: "pkr.preflight/v1",
    projectRoot: root,
    ready: checks.every((check) => check.status === "pass"),
    checks,
  };
}
