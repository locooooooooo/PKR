export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface StoredRecord {
  projectId: string;
  kind: string;
  id: string;
  revision: number;
  data: JsonObject;
  updatedAt: string;
}

export interface RuntimeEvent {
  projectId: string;
  sequence: number;
  eventId: string;
  type: string;
  subjectKind: string;
  subjectId: string;
  subjectRevision: number;
  commandId: string;
  occurredAt: string;
  data: JsonObject;
}

export interface CommandResult<T extends JsonValue = JsonValue> {
  commandId: string;
  projectId: string;
  status: "committed" | "rejected" | "conflict";
  eventRange?: {
    firstSequence: number;
    lastSequence: number;
  };
  value?: T;
  errors: Array<{
    code: string;
    message: string;
  }>;
  completedAt: string;
}

export interface InitOptions {
  name: string;
  title: string;
  outcome: string;
  description?: string;
  authorityId?: string;
  requestId?: string;
}

export interface RuntimePaths {
  root: string;
  stateDir: string;
  database: string;
  projections: string;
  config: string;
}
