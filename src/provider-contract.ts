import type { JsonObject } from "./types.js";

const CALLBACK_FIELDS = new Set([
  "outcome",
  "completed",
  "incomplete",
  "blockers",
  "evidenceIds",
  "outputs",
  "nextAction",
  "extensions",
]);

const EXTENSION_KEY = /^[a-z][a-z0-9.-]*\/[a-z][a-z0-9.-]*$/;

export interface ProviderAdapterIsolation {
  filesystem: "none" | "scoped" | "unrestricted";
  network: "none" | "scoped" | "unrestricted";
  credentials: "none" | "references-only" | "host-managed";
}

export interface ProviderAdapterDeclaration {
  id: string;
  version: string;
  capabilities: readonly string[];
  isolation: Readonly<ProviderAdapterIsolation>;
}

export const LOCAL_PROCESS_ADAPTER_CONTRACT = {
  id: "pkr.adapter.local-process",
  version: "0.6.0",
  capabilities: ["filesystem.read", "filesystem.write", "terminal"],
  isolation: {
    filesystem: "scoped",
    network: "none",
    credentials: "references-only",
  },
} as const satisfies ProviderAdapterDeclaration;

export const HTTP_JSON_ADAPTER_CONTRACT = {
  id: "pkr.adapter.http-json",
  version: "0.1.0",
  capabilities: ["filesystem.read", "filesystem.write", "terminal"],
  isolation: {
    filesystem: "scoped",
    network: "scoped",
    credentials: "host-managed",
  },
} as const satisfies ProviderAdapterDeclaration;

export interface ProviderOutputDeclaration {
  kind: "proposal" | "result" | "patch" | "log" | "artifact";
  locator: string;
  digest?: string;
}

export interface ProviderCallback {
  outcome: "verified" | "partial" | "blocked" | "externalSignoffBlocked";
  completed: string[];
  incomplete: string[];
  blockers: string[];
  evidenceIds: string[];
  outputs: ProviderOutputDeclaration[];
  nextAction: string;
  extensions?: JsonObject;
}

export function providerCallbackFailure(callback: unknown): string | null {
  if (!callback || Array.isArray(callback) || typeof callback !== "object") {
    return "InvalidCallbackShape";
  }
  const value = callback as Record<string, unknown>;
  if ([...Object.keys(value)].some((field) => !CALLBACK_FIELDS.has(field))) {
    return "UnnamespacedCallbackField";
  }
  const outcome = value.outcome;
  const completed = value.completed;
  const incomplete = value.incomplete;
  const blockers = value.blockers;
  const evidenceIds = value.evidenceIds;
  const outputs = value.outputs;
  if (
    !["verified", "partial", "blocked", "externalSignoffBlocked"].includes(outcome as string) ||
    !stringArray(completed) ||
    !stringArray(incomplete) ||
    !stringArray(blockers) ||
    !stringArray(evidenceIds, true) ||
    new Set(evidenceIds).size !== evidenceIds.length ||
    !Array.isArray(outputs) ||
    outputs.some((output) => !validProviderOutput(output)) ||
    typeof value.nextAction !== "string" ||
    !value.nextAction.trim() ||
    !validExtensions(value.extensions)
  ) {
    return "InvalidCallbackShape";
  }
  if (
    outcome === "verified" &&
    (incomplete.length !== 0 || blockers.length !== 0 || evidenceIds.length === 0)
  ) {
    return "VerifiedCallbackRequiresEvidenceAndNoResidualWork";
  }
  if (outcome === "partial" && incomplete.length === 0) {
    return "PartialCallbackRequiresIncompleteWork";
  }
  if (["blocked", "externalSignoffBlocked"].includes(outcome as string) && blockers.length === 0) {
    return "BlockedCallbackRequiresBlocker";
  }
  return null;
}

export function parseProviderCallback(text: string): ProviderCallback {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`InvalidJson:${error instanceof Error ? error.message : String(error)}`);
  }
  const failure = providerCallbackFailure(parsed);
  if (failure) {
    throw new Error(failure);
  }
  return parsed as ProviderCallback;
}

function stringArray(value: unknown, requireNonEmpty = false): value is string[] {
  return Array.isArray(value) && value.every((item) =>
    typeof item === "string" && (!requireNonEmpty || item.length > 0)
  );
}

function validProviderOutput(value: unknown): boolean {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  const output = value as Record<string, unknown>;
  return Object.keys(output).every((field) => ["kind", "locator", "digest"].includes(field)) &&
    ["proposal", "result", "patch", "log", "artifact"].includes(output.kind as string) &&
    typeof output.locator === "string" && !!output.locator &&
    (output.digest === undefined || typeof output.digest === "string");
}

function validExtensions(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  return !!value && !Array.isArray(value) && typeof value === "object" &&
    Object.keys(value as Record<string, unknown>).every((key) => EXTENSION_KEY.test(key));
}
