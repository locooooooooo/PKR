import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PkrError } from "./errors.js";
import type { CommandResult, JsonObject, JsonValue, RuntimeEvent, StoredRecord } from "./types.js";
import { newId, now, sha256, stableStringify } from "./util.js";

interface RecordRow {
  project_id: string;
  kind: string;
  record_id: string;
  revision: number;
  data_json: string;
  updated_at: string;
}

interface EventRow {
  project_id: string;
  sequence: number;
  event_id: string;
  type: string;
  subject_kind: string;
  subject_id: string;
  subject_revision: number;
  command_id: string;
  occurred_at: string;
  data_json: string;
}

interface CommandRow {
  digest: string;
  result_json: string;
}

export class StoreTransaction {
  readonly startSequence: number;

  constructor(
    private readonly database: DatabaseSync,
    readonly projectId: string,
    readonly commandId: string,
  ) {
    this.startSequence = this.currentSequence();
  }

  currentSequence(): number {
    const row = this.database
      .prepare("SELECT value FROM metadata WHERE key = 'project_sequence'")
      .get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  getRecord(kind: string, id: string): StoredRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT project_id, kind, record_id, revision, data_json, updated_at " +
          "FROM records WHERE project_id = ? AND kind = ? AND record_id = ?",
      )
      .get(this.projectId, kind, id) as RecordRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  seedRecord(kind: string, id: string, revision: number, data: JsonObject): StoredRecord {
    if (this.getRecord(kind, id)) {
      throw new PkrError(
        "PKR-RUNTIME-005",
        `${kind}/${id} already exists`,
        "conflict",
      );
    }
    const updatedAt = now();
    this.database
      .prepare(
        "INSERT INTO records(project_id, kind, record_id, revision, data_json, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(this.projectId, kind, id, revision, JSON.stringify(data), updatedAt);
    return { projectId: this.projectId, kind, id, revision, data, updatedAt };
  }

  putRecord(
    kind: string,
    id: string,
    expectedRevision: number,
    data: JsonObject,
  ): StoredRecord {
    const existing = this.getRecord(kind, id);
    const actualRevision = existing?.revision ?? 0;
    if (actualRevision !== expectedRevision) {
      throw new PkrError(
        "PKR-RUNTIME-005",
        `${kind}/${id} expected revision ${expectedRevision}, found ${actualRevision}`,
        "conflict",
      );
    }
    const revision = expectedRevision + 1;
    const updatedAt = now();
    this.database
      .prepare(
        "INSERT INTO records(project_id, kind, record_id, revision, data_json, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(project_id, kind, record_id) DO UPDATE SET " +
          "revision = excluded.revision, data_json = excluded.data_json, updated_at = excluded.updated_at",
      )
      .run(this.projectId, kind, id, revision, JSON.stringify(data), updatedAt);
    return { projectId: this.projectId, kind, id, revision, data, updatedAt };
  }

  appendEvent(
    type: string,
    subjectKind: string,
    subjectId: string,
    subjectRevision: number,
    data: JsonObject = {},
    eventId = newId("event"),
  ): RuntimeEvent {
    const sequence = this.currentSequence() + 1;
    const occurredAt = now();
    this.database
      .prepare(
        "INSERT INTO events(project_id, sequence, event_id, type, subject_kind, subject_id, " +
          "subject_revision, command_id, occurred_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.projectId,
        sequence,
        eventId,
        type,
        subjectKind,
        subjectId,
        subjectRevision,
        this.commandId,
        occurredAt,
        JSON.stringify(data),
      );
    this.database
      .prepare(
        "INSERT INTO metadata(key, value) VALUES ('project_sequence', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(sequence));
    return {
      projectId: this.projectId,
      sequence,
      eventId,
      type,
      subjectKind,
      subjectId,
      subjectRevision,
      commandId: this.commandId,
      occurredAt,
      data,
    };
  }

  committed<T extends JsonValue>(value: T): CommandResult<T> {
    const lastSequence = this.currentSequence();
    return {
      commandId: this.commandId,
      projectId: this.projectId,
      status: "committed",
      ...(lastSequence > this.startSequence
        ? {
            eventRange: {
              firstSequence: this.startSequence + 1,
              lastSequence,
            },
          }
        : {}),
      value,
      errors: [],
      completedAt: now(),
    };
  }
}

export class PkrStore {
  private readonly database: DatabaseSync;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = FULL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS metadata(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records(
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        record_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id, kind, record_id)
      );
      CREATE TABLE IF NOT EXISTS events(
        project_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        subject_revision INTEGER NOT NULL CHECK(subject_revision > 0),
        command_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY(project_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS commands(
        project_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        PRIMARY KEY(project_id, command_id)
      );
    `);
  }

  close(): void {
    this.database.close();
  }

  execute<T extends JsonValue>(
    projectId: string,
    commandId: string,
    content: JsonObject,
    operation: (transaction: StoreTransaction) => CommandResult<T>,
  ): { result: CommandResult<T>; replayed: boolean } {
    const commandDigest = sha256(content);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare(
          "SELECT digest, result_json FROM commands WHERE project_id = ? AND command_id = ?",
        )
        .get(projectId, commandId) as CommandRow | undefined;
      if (existing) {
        if (existing.digest !== commandDigest) {
          throw new PkrError(
            "PKR-RUNTIME-006",
            `command ${commandId} was reused with different content`,
            "conflict",
          );
        }
        this.database.exec("ROLLBACK");
        return {
          result: JSON.parse(existing.result_json) as CommandResult<T>,
          replayed: true,
        };
      }

      const transaction = new StoreTransaction(this.database, projectId, commandId);
      const result = operation(transaction);
      this.database
        .prepare(
          "INSERT INTO commands(project_id, command_id, digest, result_json, committed_at) " +
            "VALUES (?, ?, ?, ?, ?)",
        )
        .run(projectId, commandId, commandDigest, JSON.stringify(result), now());

      if (process.env.PKR_FAILPOINT === "before-commit") {
        throw new Error("PKR failpoint before-commit");
      }
      this.database.exec("COMMIT");
      return { result, replayed: false };
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  replay<T extends JsonValue>(
    projectId: string,
    commandId: string,
    content: JsonObject,
  ): CommandResult<T> | undefined {
    const existing = this.database
      .prepare(
        "SELECT digest, result_json FROM commands WHERE project_id = ? AND command_id = ?",
      )
      .get(projectId, commandId) as CommandRow | undefined;
    if (!existing) {
      return undefined;
    }
    if (existing.digest !== sha256(content)) {
      throw new PkrError(
        "PKR-RUNTIME-006",
        `command ${commandId} was reused with different content`,
        "conflict",
      );
    }
    return JSON.parse(existing.result_json) as CommandResult<T>;
  }

  getRecord(projectId: string, kind: string, id: string): StoredRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT project_id, kind, record_id, revision, data_json, updated_at " +
          "FROM records WHERE project_id = ? AND kind = ? AND record_id = ?",
      )
      .get(projectId, kind, id) as RecordRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  findProjectId(): string | undefined {
    const row = this.database
      .prepare(
        "SELECT project_id FROM records WHERE kind = 'ProjectManifest' ORDER BY project_id LIMIT 1",
      )
      .get() as { project_id: string } | undefined;
    return row?.project_id;
  }

  listRecords(projectId: string, kind?: string): StoredRecord[] {
    const rows = (kind
      ? this.database
          .prepare(
            "SELECT project_id, kind, record_id, revision, data_json, updated_at " +
              "FROM records WHERE project_id = ? AND kind = ? ORDER BY record_id",
          )
          .all(projectId, kind)
      : this.database
          .prepare(
            "SELECT project_id, kind, record_id, revision, data_json, updated_at " +
              "FROM records WHERE project_id = ? ORDER BY kind, record_id",
          )
          .all(projectId)) as unknown as RecordRow[];
    return rows.map(rowToRecord);
  }

  listEvents(projectId: string, afterSequence = 0): RuntimeEvent[] {
    const rows = this.database
      .prepare(
        "SELECT project_id, sequence, event_id, type, subject_kind, subject_id, " +
          "subject_revision, command_id, occurred_at, data_json FROM events " +
          "WHERE project_id = ? AND sequence > ? ORDER BY sequence",
      )
      .all(projectId, afterSequence) as unknown as EventRow[];
    return rows.map((row) => ({
      projectId: row.project_id,
      sequence: row.sequence,
      eventId: row.event_id,
      type: row.type,
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      subjectRevision: row.subject_revision,
      commandId: row.command_id,
      occurredAt: row.occurred_at,
      data: JSON.parse(row.data_json) as JsonObject,
    }));
  }

  stateDigest(projectId: string): string {
    return sha256({
      records: this.listRecords(projectId).map((record) => ({
        kind: record.kind,
        id: record.id,
        revision: record.revision,
        data: record.data,
      })),
      events: this.listEvents(projectId),
    });
  }

  exportState(projectId: string): JsonObject {
    return {
      projectId,
      records: this.listRecords(projectId) as unknown as JsonValue,
      events: this.listEvents(projectId) as unknown as JsonValue,
      digest: this.stateDigest(projectId),
    };
  }
}

function rowToRecord(row: RecordRow): StoredRecord {
  return {
    projectId: row.project_id,
    kind: row.kind,
    id: row.record_id,
    revision: row.revision,
    data: JSON.parse(row.data_json) as JsonObject,
    updatedAt: row.updated_at,
  };
}

export function commandContent(value: JsonObject): JsonObject {
  return JSON.parse(stableStringify(value)) as JsonObject;
}
