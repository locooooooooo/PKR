import { spawn } from "node:child_process";

export interface BoundedProcessOptions {
  executable: string;
  args?: string[];
  cwd: string;
  input?: string;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}

export interface BoundedProcessResult {
  executable: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  failureReason: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export function runBoundedProcess(
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  const args = options.args ?? [];
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let failureReason: string | null = null;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (!failureReason && exitCode !== 0) {
        failureReason = exitCode === null ? "ProcessTerminated" : `ExitCode:${exitCode}`;
      }
      const completed = Date.now();
      resolve({
        executable: options.executable,
        args,
        cwd: options.cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        failureReason,
        startedAt,
        completedAt: new Date(completed).toISOString(),
        durationMs: completed - started,
      });
    };

    let child;
    try {
      child = spawn(options.executable, args, {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...options.environment },
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      failureReason = `SpawnFailed:${error instanceof Error ? error.message : String(error)}`;
      finish(null, null);
      return;
    }

    const enforceOutputLimit = (): void => {
      if (
        !failureReason &&
        Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > maxOutputBytes
      ) {
        failureReason = "OutputLimitExceeded";
        child.kill();
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      enforceOutputLimit();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      enforceOutputLimit();
    });
    child.on("error", (error) => {
      failureReason = `SpawnFailed:${error.message}`;
      finish(null, null);
    });
    child.on("close", (exitCode, signal) => finish(exitCode, signal));

    timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        failureReason = "TimedOut";
        child.kill();
      }
    }, timeoutMs);

    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}
