import { spawn } from "node:child_process";

export interface BoundedProcessOptions {
  executable: string;
  args?: string[];
  cwd: string;
  input?: string;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  maxInputBytes?: number;
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
  outputTruncated: boolean;
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
  const maxInputBytes = options.maxInputBytes ?? 2 * 1024 * 1024;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new RangeError("process timeout must be between 1 and 600000 milliseconds");
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1024 * 1024) {
    throw new RangeError("process output limit must be between 1 byte and 1 MiB");
  }
  if (!Number.isInteger(maxInputBytes) || maxInputBytes < 0 || maxInputBytes > 2 * 1024 * 1024) {
    throw new RangeError("process input limit must be between 0 bytes and 2 MiB");
  }
  const input = options.input ?? "";
  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let outputTruncated = false;
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
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        outputTruncated,
        failureReason,
        startedAt,
        completedAt: new Date(completed).toISOString(),
        durationMs: completed - started,
      });
    };

    if (Buffer.byteLength(input, "utf8") > maxInputBytes) {
      failureReason = "InputLimitExceeded";
      finish(null, null);
      return;
    }

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

    const appendBounded = (chunk: Buffer, target: Buffer[]): void => {
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining > 0) {
        const accepted = chunk.subarray(0, remaining);
        target.push(accepted);
        outputBytes += accepted.byteLength;
      }
      if (chunk.byteLength > remaining && !failureReason) {
        outputTruncated = true;
        failureReason = "OutputLimitExceeded";
        child.kill("SIGKILL");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => appendBounded(chunk, stdoutChunks));
    child.stderr.on("data", (chunk: Buffer) => appendBounded(chunk, stderrChunks));
    child.on("error", (error) => {
      failureReason = `SpawnFailed:${error.message}`;
      finish(null, null);
    });
    child.on("close", (exitCode, signal) => finish(exitCode, signal));

    timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        failureReason = "TimedOut";
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}
