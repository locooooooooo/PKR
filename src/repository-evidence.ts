import { PkrError } from "./errors.js";
import type { JsonObject, JsonValue } from "./types.js";
import { digest, stableStringify } from "./util.js";

export const REPOSITORY_EVIDENCE_ADAPTER = "pkr.git-workspace/v1";
export const REPOSITORY_EVIDENCE_REF_VERSION = "pkr.repository-evidence-ref/v1";

export interface RepositoryEvidenceContent extends JsonObject {
  head: string;
  status: string;
  diff: string;
  stagedDiff: string;
  changedFiles: string[];
}

export interface RepositoryEvidenceRef extends JsonObject {
  refVersion: typeof REPOSITORY_EVIDENCE_REF_VERSION;
  adapter: typeof REPOSITORY_EVIDENCE_ADAPTER;
  contentDigest: string;
  byteLength: number;
  head?: string;
  changedFiles?: string[];
  clean?: boolean;
  observation?: JsonObject;
}

export interface StoredRepositoryEvidence {
  ref: RepositoryEvidenceRef;
  content: RepositoryEvidenceContent;
  createdAt: string;
}

function fail(message: string): never {
  throw new PkrError("PKR-EVIDENCE-001", message);
}

export function repositoryEvidenceContent(value: JsonObject): RepositoryEvidenceContent {
  if (
    value.adapter !== REPOSITORY_EVIDENCE_ADAPTER ||
    typeof value.head !== "string" ||
    typeof value.status !== "string" ||
    typeof value.diff !== "string" ||
    typeof value.stagedDiff !== "string" ||
    !Array.isArray(value.changedFiles) ||
    value.changedFiles.some((path) => typeof path !== "string")
  ) {
    fail("RepositoryEvidence is incomplete or uses an unsupported adapter");
  }
  return {
    head: value.head,
    status: value.status,
    diff: value.diff,
    stagedDiff: value.stagedDiff,
    changedFiles: [...value.changedFiles] as string[],
  };
}

export function repositoryEvidenceRef(value: JsonObject): RepositoryEvidenceRef {
  const content = repositoryEvidenceContent(value);
  const contentDigest = digest(content);
  if (
    value.contentDigest !== contentDigest ||
    typeof value.repositoryRoot !== "string" ||
    typeof value.clean !== "boolean" ||
    value.clean !== (content.changedFiles.length === 0) ||
    typeof value.collectedAt !== "string"
  ) {
    fail("RepositoryEvidence metadata or contentDigest conflicts with its raw content");
  }
  return {
    refVersion: REPOSITORY_EVIDENCE_REF_VERSION,
    adapter: REPOSITORY_EVIDENCE_ADAPTER,
    contentDigest,
    byteLength: Buffer.byteLength(stableStringify(content), "utf8"),
    head: content.head,
    changedFiles: [...content.changedFiles],
    clean: value.clean === true,
    observation: {
      repositoryRoot: value.repositoryRoot,
      collectedAt: value.collectedAt,
    },
  };
}

export function isRepositoryEvidence(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as JsonObject;
  return candidate.adapter === REPOSITORY_EVIDENCE_ADAPTER &&
    typeof candidate.contentDigest === "string" &&
    typeof candidate.diff === "string" &&
    typeof candidate.stagedDiff === "string";
}

export function isRepositoryEvidenceRef(value: unknown): value is RepositoryEvidenceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as JsonObject;
  const observation = candidate.observation as JsonObject | undefined;
  return candidate.refVersion === REPOSITORY_EVIDENCE_REF_VERSION &&
    candidate.adapter === REPOSITORY_EVIDENCE_ADAPTER &&
    typeof candidate.contentDigest === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(candidate.contentDigest) &&
    Number.isInteger(candidate.byteLength) &&
    (candidate.byteLength as number) >= 0 &&
    (candidate.head === undefined || typeof candidate.head === "string") &&
    (candidate.changedFiles === undefined ||
      (Array.isArray(candidate.changedFiles) &&
        candidate.changedFiles.every((path) => typeof path === "string"))) &&
    (candidate.clean === undefined || typeof candidate.clean === "boolean") &&
    (candidate.observation === undefined ||
      (!!observation &&
        typeof observation === "object" &&
        !Array.isArray(observation) &&
        Object.keys(observation).every((key) =>
          key === "repositoryRoot" || key === "collectedAt"
        ) &&
        (observation.repositoryRoot === undefined ||
          typeof observation.repositoryRoot === "string") &&
        (observation.collectedAt === undefined || typeof observation.collectedAt === "string")));
}

export function assertRepositoryEvidenceRef(value: JsonObject): RepositoryEvidenceRef {
  if (!isRepositoryEvidenceRef(value)) {
    fail("RepositoryEvidenceRef is incomplete or invalid");
  }
  return value;
}

export function stableRepositoryEvidenceRef(value: RepositoryEvidenceRef): RepositoryEvidenceRef {
  return {
    refVersion: value.refVersion,
    adapter: value.adapter,
    contentDigest: value.contentDigest,
    byteLength: value.byteLength,
  };
}

export function stabilizeRepositoryEvidenceRefs(value: JsonValue): JsonValue {
  if (isRepositoryEvidenceRef(value)) {
    return stableRepositoryEvidenceRef(value);
  }
  if (Array.isArray(value)) {
    return value.map(stabilizeRepositoryEvidenceRefs);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = stabilizeRepositoryEvidenceRefs(child as JsonValue);
  }
  return output;
}

export function replaceRawRepositoryEvidence(
  value: JsonValue,
  onEvidence: (evidence: JsonObject) => RepositoryEvidenceRef,
): JsonValue {
  if (isRepositoryEvidence(value)) {
    return onEvidence(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceRawRepositoryEvidence(item, onEvidence));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = replaceRawRepositoryEvidence(child as JsonValue, onEvidence);
  }
  return output;
}

export function collectRepositoryEvidenceRefs(value: JsonValue): RepositoryEvidenceRef[] {
  if (isRepositoryEvidenceRef(value)) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectRepositoryEvidenceRefs(item));
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.values(value).flatMap((child) =>
    collectRepositoryEvidenceRefs(child as JsonValue)
  );
}

export function findRawRepositoryEvidence(
  value: JsonValue,
  contentDigest: string,
): JsonObject | undefined {
  if (isRepositoryEvidence(value) && value.contentDigest === contentDigest) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRawRepositoryEvidence(item, contentDigest);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  for (const child of Object.values(value)) {
    const found = findRawRepositoryEvidence(child as JsonValue, contentDigest);
    if (found) {
      return found;
    }
  }
  return undefined;
}
