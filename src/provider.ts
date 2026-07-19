import { spawn } from "node:child_process";

import { PkrError } from "./errors.js";
import type { JsonObject } from "./types.js";

export interface ProviderCallback {
  outcome: "verified" | "partial" | "blocked" | "externalSignoffBlocked";
  completed: string[];
  incomplete: string[];
  blockers: string[];
  evidenceIds: string[];
  nextAction: string;
}

export interface ProviderExecutionRequest {
  assignmentId: string;
  sessionId: string;
  workspace: JsonObject;
}

export interface AgentProviderAdapter {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  execute(request: ProviderExecutionRequest): Promise<ProviderCallback>;
}

export class LocalProcessAdapter implements AgentProviderAdapter {
  readonly id = "pkr.adapter.local-process";
  readonly version = "0.6.0";
  readonly capabilities = ["filesystem.read", "filesystem.write", "terminal"] as const;

  constructor(
    private readonly executable: string,
    private readonly workerScript: string,
    private readonly timeoutMs = 10_000,
    private readonly environment: NodeJS.ProcessEnv = {},
  ) {}

  execute(request: ProviderExecutionRequest): Promise<ProviderCallback> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [this.workerScript], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.environment },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          child.kill();
          settled = true;
          reject(new PkrError("PKR-COORD-006", "provider process timed out"));
        }
      }, this.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new PkrError("PKR-COORD-006", `provider failed to start: ${error.message}`));
        }
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (settled) {
          return;
        }
        settled = true;
        if (code !== 0) {
          reject(
            new PkrError(
              "PKR-COORD-006",
              `provider exited with ${code}: ${stderr.trim() || "no diagnostics"}`,
            ),
          );
          return;
        }
        try {
          const callback = JSON.parse(stdout) as ProviderCallback;
          if (
            !["verified", "partial", "blocked", "externalSignoffBlocked"].includes(
              callback.outcome,
            ) ||
            !Array.isArray(callback.evidenceIds)
          ) {
            throw new Error("invalid callback shape");
          }
          resolve(callback);
        } catch (error) {
          reject(
            new PkrError(
              "PKR-COORD-008",
              `provider returned invalid callback: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}
