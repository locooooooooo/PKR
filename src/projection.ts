import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { PkrStore } from "./store.js";
import type { JsonObject, JsonValue } from "./types.js";
import { digest, writeJsonAtomic } from "./util.js";

export interface ShareableProjectionOptions {
  /** Maximum serialized UTF-8 size of the shareable export. */
  maxBytes?: number;
}

export class ShareableProjectionError extends Error {
  constructor(
    readonly code: "PKR-PROJECTION-002" | "PKR-PROJECTION-003",
    message: string,
  ) {
    super(message);
    this.name = "ShareableProjectionError";
  }
}

const DEFAULT_SHAREABLE_MAX_BYTES = 1024 * 1024;
const RAW_EVIDENCE_KEY = /^(?:diff|stagedDiff|stdout|stderr)$/i;
const PRIVATE_KEY = /(?:api[-_]?key|access[-_]?token|authorization|auth[-_]?token|cookie|password|passwd|secret|private[-_]?key|refresh[-_]?token|client[-_]?secret|prompt)/i;
const PATH_KEY = /(?:repository|working|project)?(?:root|path|directory|cwd|workdir)$/i;
const ABSOLUTE_PATH = /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]|\\\\|\/Users\/|\/home\/|\/workspace\/|file:\/\/)/;
const SECRET_VALUE = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b|\b(?:sk|pk)_[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\bxox[baprs]-[0-9A-Za-z-]{10,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)/i;

interface RedactionNotice {
  path: string;
  reason: "raw-evidence" | "sensitive-field" | "absolute-path" | "sensitive-value";
  digest?: string;
  bytes?: number;
}

function redactionMarker(reason: RedactionNotice["reason"]): string {
  return `[redacted:shareable:${reason}]`;
}

function redactValue(
  value: JsonValue,
  path: string,
  notices: RedactionNotice[],
): JsonValue {
  if (typeof value === "string") {
    if (ABSOLUTE_PATH.test(value)) {
      notices.push({ path, reason: "absolute-path" });
      return redactionMarker("absolute-path");
    }
    if (SECRET_VALUE.test(value)) {
      notices.push({ path, reason: "sensitive-value" });
      return redactionMarker("sensitive-value");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, `${path}[${index}]`, notices));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    const reason = RAW_EVIDENCE_KEY.test(key)
      ? "raw-evidence"
      : PRIVATE_KEY.test(key)
        ? "sensitive-field"
        : PATH_KEY.test(key)
          ? "absolute-path"
          : undefined;
    if (reason) {
      const notice: RedactionNotice = {
        path: childPath,
        reason,
      };
      if (reason === "raw-evidence") {
        const raw = JSON.stringify(child);
        notice.digest = digest(child);
        notice.bytes = Buffer.byteLength(raw, "utf8");
      }
      notices.push(notice);
      output[key] = redactionMarker(reason);
      continue;
    }
    output[key] = redactValue(child, childPath, notices);
  }
  return output;
}

/**
 * Build a deliberately lossy export for sharing outside the local Runtime.
 * The SQLite-backed authority and local projections remain untouched.
 */
export function buildShareableProjection(
  source: JsonObject,
  options: ShareableProjectionOptions = {},
): JsonObject {
  const notices: RedactionNotice[] = [];
  const sourceStateDigest = typeof source.digest === "string" ? source.digest : digest(source);
  const records = Array.isArray(source.records)
    ? source.records.map((record, index) => redactValue(record, `records[${index}]`, notices))
    : [];
  const events = Array.isArray(source.events)
    ? source.events.map((event, index) => redactValue(event, `events[${index}]`, notices))
    : [];
  const repositoryEvidence = Array.isArray(source.repositoryEvidence)
    ? source.repositoryEvidence.map((ref, index) =>
      redactValue(ref, `repositoryEvidence[${index}]`, notices)
    )
    : [];
  const body: JsonObject = {
    formatVersion: "pkr.shareable-projection/v1",
    profile: "shareable",
    projectId: typeof source.projectId === "string" ? source.projectId : "unknown",
    sourceStateDigest,
    records,
    events,
    repositoryEvidence,
    summary: {
      sourceRecordCount: records.length,
      sourceEventCount: events.length,
      repositoryEvidenceRefCount: repositoryEvidence.length,
      redactedFieldCount: notices.length,
      measuredRawEvidenceBytes: notices.reduce((total, notice) => total + (notice.bytes ?? 0), 0),
    },
    redaction: {
      profile: "shareable",
      notice: "Raw evidence remains in SQLite authority and the local per-digest evidence projection; this export is intentionally lossy.",
      notices: notices as unknown as JsonValue,
    },
  };
  const projection: JsonObject = {
    ...body,
    digest: digest(body),
  };
  const serializedBytes = Buffer.byteLength(`${JSON.stringify(projection, null, 2)}\n`, "utf8");
  const maxBytes = options.maxBytes ?? DEFAULT_SHAREABLE_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new ShareableProjectionError(
      "PKR-PROJECTION-002",
      "shareable projection maxBytes must be a positive integer",
    );
  }
  if (serializedBytes > maxBytes) {
    throw new ShareableProjectionError(
      "PKR-PROJECTION-003",
      `shareable projection exceeds ${maxBytes} byte budget (${serializedBytes} bytes); use a larger explicit budget or reduce the source state`,
    );
  }
  return projection;
}

export async function writeShareableProjection(
  store: PkrStore,
  projectId: string,
  outputPath: string,
  options: ShareableProjectionOptions = {},
): Promise<JsonObject> {
  const projection = buildShareableProjection(store.exportState(projectId), options);
  await writeJsonAtomic(outputPath, projection);
  return projection;
}

export async function rebuildProjections(
  store: PkrStore,
  projectId: string,
  stateDir: string,
  projectionsPath: string,
): Promise<void> {
  const safeRoot = resolve(stateDir);
  const safeTarget = resolve(projectionsPath);
  if (!safeTarget.startsWith(`${safeRoot}\\`) && !safeTarget.startsWith(`${safeRoot}/`)) {
    throw new Error("projection path escapes the PKR state directory");
  }
  if (basename(safeTarget) !== "projections") {
    throw new Error("projection path must end in projections");
  }

  await rm(safeTarget, { recursive: true, force: true });
  await mkdir(safeTarget, { recursive: true });
  for (const record of store.projectionRecords(projectId)) {
    const target = join(safeTarget, "records", record.kind, `${record.id}.json`);
    await writeJsonAtomic(target, record.data);
  }

  const events = store.projectionEvents(projectId);
  const eventTarget = join(safeTarget, "events.jsonl");
  const temporary = `${eventTarget}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""),
    "utf8",
  );
  await rename(temporary, eventTarget);
  for (const evidence of store.projectionRepositoryEvidence(projectId)) {
    const name = evidence.ref.contentDigest.replace(/^sha256:/, "");
    await writeJsonAtomic(
      join(safeTarget, "repository-evidence", `${name}.json`),
      {
        ref: evidence.ref,
        content: evidence.content,
        createdAt: evidence.createdAt,
      },
    );
  }
  const state = store.exportState(projectId) as JsonObject;
  await writeJsonAtomic(join(safeTarget, "state.json"), state);
}
