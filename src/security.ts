import { basename } from "node:path";

import type { BoundedProcessResult } from "./process.js";
import type { JsonObject, JsonValue, RuntimeEvent, StoredRecord } from "./types.js";
import { digest } from "./util.js";

export const MAX_CALLBACK_BYTES = 256 * 1024;
export const MAX_CALLBACK_LIST_ITEMS = 128;
export const MAX_CALLBACK_STRING_BYTES = 4 * 1024;
export const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
export const MAX_DIAGNOSTIC_EVENTS = 50;

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|private.?key|secret|token)/i;

function boundedText(value: string, maxBytes = MAX_CALLBACK_STRING_BYTES): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return value;
  }
  return `${buffer.subarray(0, maxBytes).toString("utf8")}[TRUNCATED]`;
}

export function redactSensitiveText(value: string): string {
  return boundedText(value, MAX_DIAGNOSTIC_BYTES)
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      REDACTED,
    )
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, `$1${REDACTED}`)
    .replace(
      /(["']?(?:api[_-]?key|credential|password|private[_-]?key|secret|token)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED)
    .replace(/[A-Za-z]:\\Users\\[^\s"']+/gi, "[ABSOLUTE-PATH]")
    .replace(/\/(?:home|Users)\/[^\s"']+/g, "[ABSOLUTE-PATH]");
}

function redactArguments(args: string[]): string[] {
  let redactNext = false;
  return args.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED;
    }
    if (/^--?(?:api[_-]?key|credential|password|secret|token)$/i.test(argument)) {
      redactNext = true;
      return argument;
    }
    return redactSensitiveText(argument);
  });
}

export function sanitizeProcessResult(
  result: BoundedProcessResult,
  options: { omitStdout?: boolean } = {},
): BoundedProcessResult {
  return {
    ...result,
    executable: basename(result.executable),
    args: redactArguments(result.args),
    cwd: "[PROJECT-ROOT]",
    stdout: options.omitStdout ? "[OMITTED: parsed structured output]" : redactSensitiveText(result.stdout),
    stderr: redactSensitiveText(result.stderr),
  };
}

export function isSafeOutputLocator(locator: unknown): locator is string {
  if (
    typeof locator !== "string" ||
    locator.length === 0 ||
    Buffer.byteLength(locator, "utf8") > 2_048 ||
    locator.includes("\0")
  ) {
    return false;
  }
  if (locator.startsWith("pkr://")) {
    try {
      const parsed = new URL(locator);
      return parsed.protocol === "pkr:" && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }
  const normalized = locator.replaceAll("\\", "/");
  return !normalized.startsWith("/") &&
    !/^[a-zA-Z]:/.test(normalized) &&
    normalized.split("/").every((segment) => segment !== ".." && segment !== "");
}

export function isBoundedCallbackPayload(callback: unknown): callback is JsonObject {
  if (!callback || typeof callback !== "object" || Array.isArray(callback)) {
    return false;
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(callback);
  } catch {
    return false;
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_CALLBACK_BYTES) {
    return false;
  }
  const object = callback as Record<string, unknown>;
  for (const key of ["completed", "incomplete", "blockers", "evidenceIds"] as const) {
    const values = object[key];
    if (
      !Array.isArray(values) ||
      values.length > MAX_CALLBACK_LIST_ITEMS ||
      values.some((value) =>
        typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_CALLBACK_STRING_BYTES
      )
    ) {
      return false;
    }
  }
  const outputs = object.outputs;
  if (!Array.isArray(outputs) || outputs.length > MAX_CALLBACK_LIST_ITEMS) {
    return false;
  }
  if (
    typeof object.nextAction !== "string" ||
    Buffer.byteLength(object.nextAction, "utf8") > MAX_CALLBACK_STRING_BYTES
  ) {
    return false;
  }
  return true;
}

export function redactDiagnosticValue(
  value: JsonValue,
  depth = 0,
): JsonValue {
  if (depth >= 6) {
    return "[OMITTED: depth limit]";
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const selected = value.slice(0, 50).map((item) => redactDiagnosticValue(item, depth + 1));
    return value.length > selected.length ? [...selected, "[OMITTED: item limit]"] : selected;
  }
  const output: JsonObject = {};
  const entries = Object.entries(value).slice(0, 100);
  for (const [key, item] of entries) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactDiagnosticValue(item, depth + 1);
  }
  if (Object.keys(value).length > entries.length) {
    output.__notice = "[OMITTED: key limit]";
  }
  return output;
}

interface DiagnosticRuntime {
  projectId: string;
  status(): JsonObject;
  listRecords(kind?: string): StoredRecord[];
  listEvents(afterSequence?: number): RuntimeEvent[];
}

export function createDiagnosticExport(runtime: DiagnosticRuntime): JsonObject {
  const status = runtime.status();
  const records = runtime.listRecords();
  const events = runtime.listEvents();
  const phaseCounts: Record<string, Record<string, number>> = {};
  for (const record of records) {
    const phase = (record.data.status as JsonObject | undefined)?.phase;
    if (typeof phase !== "string") continue;
    phaseCounts[record.kind] ??= {};
    phaseCounts[record.kind]![phase] = (phaseCounts[record.kind]![phase] ?? 0) + 1;
  }
  const eventSummary = events.slice(-MAX_DIAGNOSTIC_EVENTS).map((event) => ({
    sequence: event.sequence,
    type: event.type,
    subjectKind: event.subjectKind,
    subjectRevision: event.subjectRevision,
  }));
  const report: JsonObject = {
    version: "pkr.diagnostics/v1",
    generatedAt: new Date().toISOString(),
    authority: "SQLite .pkr/runtime.sqlite",
    project: {
      identityDigest: digest(runtime.projectId),
      phase: status.phase ?? null,
      projectSequence: status.projectSequence ?? 0,
      stateDigest: status.stateDigest ?? null,
      recordCounts: status.recordCounts ?? {},
      phaseCounts,
    },
    events: {
      total: events.length,
      included: eventSummary.length,
      omitted: Math.max(0, events.length - eventSummary.length),
      summaries: eventSummary,
    },
    limits: {
      maxBytes: MAX_DIAGNOSTIC_BYTES,
      maxEvents: MAX_DIAGNOSTIC_EVENTS,
      recordBodies: "omitted",
      eventData: "omitted",
      repositoryDiffs: "omitted",
      processOutput: "omitted",
    },
  };
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_DIAGNOSTIC_BYTES) {
    throw new Error("diagnostic export exceeds its hard size limit");
  }
  return report;
}
