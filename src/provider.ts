import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { PkrError } from "./errors.js";
import { runBoundedProcess, type BoundedProcessResult } from "./process.js";
import {
  HTTP_JSON_ADAPTER_CONTRACT,
  LOCAL_PROCESS_ADAPTER_CONTRACT,
  parseProviderCallback,
  providerCallbackFailure,
  type ProviderAdapterIsolation,
  type ProviderCallback,
} from "./provider-contract.js";
import {
  isBoundedCallbackPayload,
  isSafeOutputLocator,
  sanitizeProcessResult,
} from "./security.js";
import type { JsonObject } from "./types.js";

export {
  HTTP_JSON_ADAPTER_CONTRACT,
  LOCAL_PROCESS_ADAPTER_CONTRACT,
  parseProviderCallback,
  providerCallbackFailure,
} from "./provider-contract.js";
export type {
  ProviderAdapterDeclaration,
  ProviderAdapterIsolation,
  ProviderCallback,
  ProviderOutputDeclaration,
} from "./provider-contract.js";

export interface ProviderProcessEvidence extends BoundedProcessResult {
  extensions: JsonObject;
}

export interface ProviderExecutionResult {
  callback: ProviderCallback | null;
  process: ProviderProcessEvidence;
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
  readonly isolation: Readonly<ProviderAdapterIsolation>;
  execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult>;
}

export interface LocalProviderConfig {
  version: "pkr.provider/v1";
  adapter: {
    id: string;
    version: string;
    capabilities: string[];
  };
  command: {
    executable: string;
    args: string[];
    timeoutMs: number;
  };
}

export class LocalProcessAdapter implements AgentProviderAdapter {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly isolation: Readonly<ProviderAdapterIsolation> = LOCAL_PROCESS_ADAPTER_CONTRACT.isolation;

  constructor(
    private readonly executable: string,
    private readonly commandArgs: string | string[],
    private readonly timeoutMs = 10_000,
    private readonly environment: NodeJS.ProcessEnv = {},
    binding: LocalProviderConfig["adapter"] = {
      id: LOCAL_PROCESS_ADAPTER_CONTRACT.id,
      version: LOCAL_PROCESS_ADAPTER_CONTRACT.version,
      capabilities: [...LOCAL_PROCESS_ADAPTER_CONTRACT.capabilities],
    },
  ) {
    this.id = binding.id;
    this.version = binding.version;
    this.capabilities = [...binding.capabilities];
  }

  async execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult> {
    const repository = (request.workspace.extensions as JsonObject | undefined)?.[
      "pkr.workspace/repository"
    ] as JsonObject | undefined;
    const processResult = await runBoundedProcess({
      executable: this.executable,
      args: typeof this.commandArgs === "string" ? [this.commandArgs] : this.commandArgs,
      cwd: (repository?.repositoryRoot as string | undefined) ?? process.cwd(),
      input: JSON.stringify(request),
      timeoutMs: this.timeoutMs,
      environment: this.environment,
      maxOutputBytes: 256 * 1024,
    });
    const processEvidence = withTransportExtension(processResult, "pkr.adapter.local-process/transport", {
      protocol: "stdio-json",
    });
    if (processEvidence.failureReason) {
      return { callback: null, process: sanitizeProviderProcessEvidence(processEvidence) };
    }
    try {
      const callback = parseBoundedProviderCallback(processResult.stdout);
      return {
        callback,
        process: sanitizeProviderProcessEvidence(processEvidence, { omitStdout: true }),
      };
    } catch (error) {
      return {
        callback: null,
        process: {
          ...sanitizeProviderProcessEvidence(processEvidence),
          failureReason: `InvalidProviderOutput:${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }
}

export interface HttpJsonAdapterOptions {
  endpoint: string | URL;
  timeoutMs?: number;
  maxResponseBytes?: number;
  headers?: Readonly<Record<string, string>>;
  fetch?: typeof fetch;
  binding?: {
    id: string;
    version: string;
    capabilities: string[];
  };
}

export class HttpJsonAdapter implements AgentProviderAdapter {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly isolation: Readonly<ProviderAdapterIsolation> = HTTP_JSON_ADAPTER_CONTRACT.isolation;

  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: HttpJsonAdapterOptions) {
    this.endpoint = new URL(options.endpoint);
    if (
      !["http:", "https:"].includes(this.endpoint.protocol) ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.hash
    ) {
      throw new PkrError(
        "PKR-PROVIDER-001",
        "HTTP Provider endpoint must be an http(s) URL without embedded credentials or a fragment",
      );
    }
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 256 * 1024;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 600_000 ||
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1 ||
      this.maxResponseBytes > 16 * 1024 * 1024
    ) {
      throw new PkrError(
        "PKR-PROVIDER-001",
        "HTTP Provider requires bounded timeout and response-size limits",
      );
    }
    this.headers = options.headers ?? {};
    this.fetchImplementation = options.fetch ?? fetch;
    const binding = options.binding ?? {
      id: HTTP_JSON_ADAPTER_CONTRACT.id,
      version: HTTP_JSON_ADAPTER_CONTRACT.version,
      capabilities: [...HTTP_JSON_ADAPTER_CONTRACT.capabilities],
    };
    validateAdapterDeclaration(binding);
    this.id = binding.id;
    this.version = binding.version;
    this.capabilities = [...binding.capabilities];
  }

  async execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult> {
    const repository = (request.workspace.extensions as JsonObject | undefined)?.[
      "pkr.workspace/repository"
    ] as JsonObject | undefined;
    const cwd = (repository?.repositoryRoot as string | undefined) ?? process.cwd();
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let responseBody = "";
    let statusCode: number | null = null;
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers: {
          ...this.headers,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        redirect: "error",
        signal: controller.signal,
      });
      statusCode = response.status;
      responseBody = await readBoundedResponse(response, this.maxResponseBytes);
      const completed = Date.now();
      const processEvidence = httpProcessEvidence({
        cwd,
        startedAt,
        completed,
        endpointOrigin: this.endpoint.origin,
        responseBody,
        statusCode,
        failureReason: response.ok ? null : `HttpStatus:${response.status}`,
        timedOut: false,
      });
      if (!response.ok) {
        return { callback: null, process: sanitizeProviderProcessEvidence(processEvidence) };
      }
      try {
        return {
          callback: parseBoundedProviderCallback(responseBody),
          process: sanitizeProviderProcessEvidence(processEvidence, { omitStdout: true }),
        };
      } catch (error) {
        return {
          callback: null,
          process: {
            ...sanitizeProviderProcessEvidence(processEvidence),
            failureReason: `InvalidProviderOutput:${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
    } catch (error) {
      const completed = Date.now();
      const timedOut = controller.signal.aborted;
      const failureReason = timedOut
        ? "TimedOut"
        : error instanceof Error && error.message === "ResponseLimitExceeded"
          ? "OutputLimitExceeded"
          : `TransportError:${error instanceof Error ? error.name : "Unknown"}`;
      return {
        callback: null,
        process: sanitizeProviderProcessEvidence(
          httpProcessEvidence({
            cwd,
            startedAt,
            completed,
            endpointOrigin: this.endpoint.origin,
            responseBody,
            statusCode,
            failureReason,
            timedOut,
          }),
        ),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseBoundedProviderCallback(text: string): ProviderCallback {
  const callback = parseProviderCallback(text);
  if (
    !isBoundedCallbackPayload(callback) ||
    callback.outputs.some((output) => !isSafeOutputLocator(output.locator))
  ) {
    throw new Error("InvalidCallbackSecurityBoundary");
  }
  return callback;
}

function sanitizeProviderProcessEvidence(
  result: ProviderProcessEvidence,
  options: { omitStdout?: boolean } = {},
): ProviderProcessEvidence {
  return {
    ...sanitizeProcessResult(result, options),
    extensions: result.extensions,
  };
}

function validateAdapterDeclaration(binding: {
  id: string;
  version: string;
  capabilities: string[];
}): void {
  if (
    !binding.id?.trim() ||
    !binding.version?.trim() ||
    !Array.isArray(binding.capabilities) ||
    binding.capabilities.length === 0 ||
    binding.capabilities.some((capability) => typeof capability !== "string" || !capability.trim()) ||
    new Set(binding.capabilities).size !== binding.capabilities.length
  ) {
    throw new PkrError("PKR-PROVIDER-001", "Provider Adapter declaration is incomplete");
  }
}

function withTransportExtension(
  result: BoundedProcessResult,
  key: string,
  value: JsonObject,
): ProviderProcessEvidence {
  return {
    ...result,
    extensions: { [key]: value },
  };
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("ResponseLimitExceeded");
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function httpProcessEvidence(input: {
  cwd: string;
  startedAt: string;
  completed: number;
  endpointOrigin: string;
  responseBody: string;
  statusCode: number | null;
  failureReason: string | null;
  timedOut: boolean;
}): ProviderProcessEvidence {
  return {
    executable: "pkr-http-json",
    args: [],
    cwd: input.cwd,
    exitCode: input.failureReason === null ? 0 : input.statusCode,
    signal: null,
    stdout: input.responseBody,
    stderr: "",
    timedOut: input.timedOut,
    outputTruncated: false,
    failureReason: input.failureReason,
    startedAt: input.startedAt,
    completedAt: new Date(input.completed).toISOString(),
    durationMs: Math.max(0, input.completed - Date.parse(input.startedAt)),
    extensions: {
      "pkr.adapter.http-json/transport": {
        protocol: "http-json",
        endpointOrigin: input.endpointOrigin,
        statusCode: input.statusCode,
      },
    },
  };
}

export async function readLocalProviderConfig(path: string): Promise<LocalProviderConfig> {
  const configPath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new PkrError(
      "PKR-PROVIDER-001",
      `cannot load local Provider config ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const config = parsed as LocalProviderConfig;
  const capabilities = config?.adapter?.capabilities;
  if (
    !config ||
    config.version !== "pkr.provider/v1" ||
    !config.adapter?.id?.trim() ||
    !config.adapter.version?.trim() ||
    !Array.isArray(capabilities) ||
    capabilities.length === 0 ||
    capabilities.some((capability) => typeof capability !== "string" || !capability.trim()) ||
    new Set(capabilities).size !== capabilities.length ||
    !config.command?.executable?.trim() ||
    !Array.isArray(config.command.args) ||
    config.command.args.length > 128 ||
    config.command.args.some((argument) =>
      typeof argument !== "string" || Buffer.byteLength(argument, "utf8") > 64 * 1024
    ) ||
    !Number.isInteger(config.command.timeoutMs) ||
    config.command.timeoutMs < 100 ||
    config.command.timeoutMs > 600_000
  ) {
    throw new PkrError(
      "PKR-PROVIDER-001",
      "local Provider config requires one Adapter binding and one bounded executable/args command",
    );
  }
  return config;
}

export function localProcessAdapterFromConfig(config: LocalProviderConfig): LocalProcessAdapter {
  return new LocalProcessAdapter(
    config.command.executable,
    config.command.args,
    config.command.timeoutMs,
    {},
    config.adapter,
  );
}

export async function loadLocalProviderConfig(path: string): Promise<LocalProcessAdapter> {
  return localProcessAdapterFromConfig(await readLocalProviderConfig(path));
}
