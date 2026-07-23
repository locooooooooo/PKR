import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PkrError } from "./errors.js";
import {
  assertRepositoryEvidenceRef,
  collectRepositoryEvidenceRefs,
  findRawRepositoryEvidence,
  repositoryEvidenceContent,
  repositoryEvidenceRef,
  replaceRawRepositoryEvidence,
  stableRepositoryEvidenceRef,
  type RepositoryEvidenceRef,
  type StoredRepositoryEvidence,
} from "./repository-evidence.js";
import type { CommandResult, JsonObject, JsonValue, RuntimeEvent, StoredRecord } from "./types.js";
import { digest, newId, now, sha256, stableStringify } from "./util.js";

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
  project_id: string;
  command_id: string;
  digest: string;
  result_json: string;
  committed_at: string;
}

interface ArchiveRow {
  project_id: string;
  archive_id: string;
  first_sequence: number;
  last_sequence: number;
  event_count: number;
  events_json: string;
  content_digest: string;
  created_at: string;
}

interface ExternalEffectRow {
  project_id: string;
  effect_id: string;
  assignment_id: string;
  request_digest: string;
  request_json: string;
  state: ExternalEffectState;
  result_json: string | null;
  created_at: string;
  completed_at: string | null;
}

export const PUBLIC_ALPHA_STORE_FORMAT = "pkr.store/v0.7.0-alpha.1";
export const CANDIDATE_STORE_FORMAT = "pkr.store/v1-candidate";
export const SNAPSHOT_FORMAT = "pkr.snapshot/v1";

const LEGACY_CANDIDATE_USER_VERSION = 1;
const CURRENT_USER_VERSION = 2;
const CORE_TABLES = ["commands", "events", "metadata", "records"] as const;
const CANDIDATE_TABLES = ["event_archives", "external_effects", "repository_evidence"] as const;
const TABLE_COLUMNS: Record<string, string[]> = {
  metadata: ["key", "value"],
  records: ["project_id", "kind", "record_id", "revision", "data_json", "updated_at"],
  events: [
    "project_id", "sequence", "event_id", "type", "subject_kind", "subject_id",
    "subject_revision", "command_id", "occurred_at", "data_json",
  ],
  commands: ["project_id", "command_id", "digest", "result_json", "committed_at"],
  event_archives: [
    "project_id", "archive_id", "first_sequence", "last_sequence", "event_count",
    "events_json", "content_digest", "created_at",
  ],
  external_effects: [
    "project_id", "effect_id", "assignment_id", "request_digest", "request_json",
    "state", "result_json", "created_at", "completed_at",
  ],
  repository_evidence: [
    "project_id", "content_digest", "adapter", "byte_length", "payload_json", "created_at",
  ],
};

export type ExternalEffectState = "pending" | "succeeded" | "failed";

export interface ExternalEffect {
  projectId: string;
  effectId: string;
  assignmentId: string;
  requestDigest: string;
  request: JsonObject;
  state: ExternalEffectState;
  result: JsonObject | null;
  createdAt: string;
  completedAt: string | null;
}

export interface RetentionPolicy {
  keepRecentEvents: number;
  auditGuarantee: "full-replay";
}

export interface CompactionResult {
  projectId: string;
  archiveId: string | null;
  archivedEvents: number;
  liveEvents: number;
  firstArchivedSequence: number | null;
  lastArchivedSequence: number | null;
  stateDigestBefore: string;
  stateDigestAfter: string;
  policy: RetentionPolicy;
}

interface SnapshotCommand {
  projectId: string;
  commandId: string;
  digest: string;
  result: JsonObject;
  committedAt: string;
}

interface SnapshotPayload {
  snapshotFormat: typeof SNAPSHOT_FORMAT;
  storeFormat: typeof CANDIDATE_STORE_FORMAT;
  projectId: string;
  createdAt: string;
  projectSequence: number;
  stateDigest: string;
  records: StoredRecord[];
  events: RuntimeEvent[];
  commands: SnapshotCommand[];
  externalEffects: ExternalEffect[];
  repositoryEvidence?: StoredRepositoryEvidence[];
  retentionPolicy: RetentionPolicy | null;
}

export interface StoreSnapshot extends SnapshotPayload {
  checksum: string;
}

export interface StoreOpenReport {
  sourceFormat: "empty" | typeof PUBLIC_ALPHA_STORE_FORMAT | typeof CANDIDATE_STORE_FORMAT;
  targetFormat: typeof CANDIDATE_STORE_FORMAT;
  migrated: boolean;
}

interface RepositoryEvidenceRow {
  content_digest: string;
  adapter: string;
  byte_length: number;
  payload_json: string;
  created_at: string;
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

  reserveExternalEffect(
    effectId: string,
    assignmentId: string,
    request: JsonObject,
  ): { effect: ExternalEffect; execute: boolean } {
    const requestDigest = sha256(request);
    const existing = this.database
      .prepare(
        "SELECT project_id, effect_id, assignment_id, request_digest, request_json, state, " +
          "result_json, created_at, completed_at FROM external_effects " +
          "WHERE project_id = ? AND effect_id = ?",
      )
      .get(this.projectId, effectId) as ExternalEffectRow | undefined;
    if (existing) {
      if (
        existing.assignment_id !== assignmentId ||
        existing.request_digest !== requestDigest
      ) {
        throw new PkrError(
          "PKR-RECOVERY-003",
          `external effect ${effectId} was reused with different content`,
          "conflict",
        );
      }
      return { effect: rowToExternalEffect(existing), execute: false };
    }

    const createdAt = now();
    this.database
      .prepare(
        "INSERT INTO external_effects(project_id, effect_id, assignment_id, request_digest, " +
          "request_json, state, result_json, created_at, completed_at) " +
          "VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)",
      )
      .run(
        this.projectId,
        effectId,
        assignmentId,
        requestDigest,
        JSON.stringify(request),
        createdAt,
      );
    return {
      effect: {
        projectId: this.projectId,
        effectId,
        assignmentId,
        requestDigest,
        request,
        state: "pending",
        result: null,
        createdAt,
        completedAt: null,
      },
      execute: true,
    };
  }

  completeExternalEffect(
    effectId: string,
    state: Exclude<ExternalEffectState, "pending">,
    result: JsonObject,
  ): { effect: ExternalEffect; changed: boolean } {
    const existing = this.database
      .prepare(
        "SELECT project_id, effect_id, assignment_id, request_digest, request_json, state, " +
          "result_json, created_at, completed_at FROM external_effects " +
          "WHERE project_id = ? AND effect_id = ?",
      )
      .get(this.projectId, effectId) as ExternalEffectRow | undefined;
    if (!existing) {
      throw new PkrError("PKR-RECOVERY-003", `external effect ${effectId} was not reserved`);
    }
    if (existing.state !== "pending") {
      const prior = rowToExternalEffect(existing);
      if (prior.state !== state || sha256(prior.result) !== sha256(result)) {
        throw new PkrError(
          "PKR-RECOVERY-003",
          `external effect ${effectId} already has a different terminal result`,
          "conflict",
        );
      }
      return { effect: prior, changed: false };
    }
    const completedAt = now();
    this.database
      .prepare(
        "UPDATE external_effects SET state = ?, result_json = ?, completed_at = ? " +
          "WHERE project_id = ? AND effect_id = ? AND state = 'pending'",
      )
      .run(state, JSON.stringify(result), completedAt, this.projectId, effectId);
    return {
      effect: {
        ...rowToExternalEffect(existing),
        state,
        result,
        completedAt,
      },
      changed: true,
    };
  }

  putRepositoryEvidence(evidence: JsonObject): RepositoryEvidenceRef {
    const ref = repositoryEvidenceRef(evidence);
    const content = repositoryEvidenceContent(evidence);
    const payload = stableStringify(content);
    this.database
      .prepare(
        "INSERT OR IGNORE INTO repository_evidence(" +
          "project_id, content_digest, adapter, byte_length, payload_json, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.projectId,
        ref.contentDigest,
        ref.adapter,
        ref.byteLength,
        payload,
        now(),
      );
    const stored = this.database
      .prepare(
        "SELECT content_digest, adapter, byte_length, payload_json, created_at " +
          "FROM repository_evidence WHERE project_id = ? AND content_digest = ?",
      )
      .get(this.projectId, ref.contentDigest) as RepositoryEvidenceRow | undefined;
    if (
      !stored ||
      stored.adapter !== ref.adapter ||
      stored.byte_length !== ref.byteLength ||
      stored.payload_json !== payload
    ) {
      throw new PkrError(
        "PKR-EVIDENCE-002",
        `RepositoryEvidence digest collision or corrupt stored payload for ${ref.contentDigest}`,
        "conflict",
      );
    }
    return ref;
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
  private readonly database!: DatabaseSync;
  readonly openReport!: StoreOpenReport;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path);
      this.database = database;
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA synchronous = FULL");
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA busy_timeout = 5000");
      this.openReport = this.prepareStore();
    } catch (error) {
      database?.close();
      if (error instanceof PkrError) {
        throw error;
      }
      throw new PkrError(
        "PKR-MIGRATION-004",
        `cannot open or validate SQLite authority: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private prepareStore(): StoreOpenReport {
    const tables = this.applicationTables();
    if (tables.length === 0) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.createCoreSchema();
        this.createCandidateSchema();
        this.database
          .prepare("INSERT INTO metadata(key, value) VALUES ('store_format', ?)")
          .run(CANDIDATE_STORE_FORMAT);
        this.database.exec(`PRAGMA user_version = ${CURRENT_USER_VERSION}`);
        this.database.exec("COMMIT");
      } catch (error) {
        if (this.database.isTransaction) {
          this.database.exec("ROLLBACK");
        }
        throw error;
      }
      return {
        sourceFormat: "empty",
        targetFormat: CANDIDATE_STORE_FORMAT,
        migrated: false,
      };
    }

    const missingCore = CORE_TABLES.filter((table) => !tables.includes(table));
    if (missingCore.length !== 0) {
      throw new PkrError(
        "PKR-MIGRATION-002",
        `partial PKR store is missing core tables: ${missingCore.join(", ")}`,
      );
    }
    for (const table of CORE_TABLES) {
      this.assertTableColumns(table);
    }
    const formatRow = this.database
      .prepare("SELECT value FROM metadata WHERE key = 'store_format'")
      .get() as { value: string } | undefined;
    const userVersion = this.userVersion();

    if (!formatRow && userVersion === 0) {
      const unexpectedCandidate = CANDIDATE_TABLES.filter((table) => tables.includes(table));
      if (unexpectedCandidate.length !== 0) {
        throw new PkrError(
          "PKR-MIGRATION-002",
          `partial candidate store has no format marker: ${unexpectedCandidate.join(", ")}`,
        );
      }
      const unsupportedTables = tables.filter((table) => !CORE_TABLES.includes(table as typeof CORE_TABLES[number]));
      if (unsupportedTables.length !== 0) {
        throw new PkrError(
          "PKR-MIGRATION-001",
          `unmarked store has unsupported tables: ${unsupportedTables.join(", ")}`,
        );
      }
      this.validateStore(false);
      if (!this.findProjectId()) {
        throw new PkrError("PKR-MIGRATION-002", "public alpha migration requires one initialized Project");
      }
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.createCandidateSchema();
        this.database
          .prepare("INSERT INTO metadata(key, value) VALUES ('store_format', ?)")
          .run(CANDIDATE_STORE_FORMAT);
        this.database.exec(`PRAGMA user_version = ${CURRENT_USER_VERSION}`);
        if (process.env.PKR_FAILPOINT === "migration-after-schema") {
          throw new Error("PKR failpoint migration-after-schema");
        }
        this.database.exec("COMMIT");
      } catch (error) {
        if (this.database.isTransaction) {
          this.database.exec("ROLLBACK");
        }
        throw error;
      }
      this.validateStore(true);
      return {
        sourceFormat: PUBLIC_ALPHA_STORE_FORMAT,
        targetFormat: CANDIDATE_STORE_FORMAT,
        migrated: true,
      };
    }

    if (formatRow?.value !== CANDIDATE_STORE_FORMAT) {
      throw new PkrError(
        "PKR-MIGRATION-001",
        `unsupported PKR store format ${formatRow?.value ?? `user_version:${userVersion}`}`,
      );
    }
    const supportedTables = new Set<string>([...CORE_TABLES, ...CANDIDATE_TABLES]);
    const unsupportedTables = tables.filter((table) => !supportedTables.has(table));
    if (unsupportedTables.length !== 0) {
      throw new PkrError(
        "PKR-MIGRATION-001",
        `candidate store has unsupported tables: ${unsupportedTables.join(", ")}`,
      );
    }
    const missingCandidate = CANDIDATE_TABLES.filter((table) => !tables.includes(table));
    if (userVersion === LEGACY_CANDIDATE_USER_VERSION) {
      const missingLegacyTables = missingCandidate.filter((table) => table !== "repository_evidence");
      if (missingLegacyTables.length !== 0) {
        throw new PkrError(
          "PKR-MIGRATION-002",
          `partial ${CANDIDATE_STORE_FORMAT} v1 store is missing tables: ${missingLegacyTables.join(", ")}`,
        );
      }
      for (const table of CANDIDATE_TABLES) {
        if (tables.includes(table)) {
          this.assertTableColumns(table);
        }
      }
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.createCandidateSchema();
        this.database.exec(`PRAGMA user_version = ${CURRENT_USER_VERSION}`);
        if (process.env.PKR_FAILPOINT === "migration-after-schema") {
          throw new Error("PKR failpoint migration-after-schema");
        }
        this.validateStore(true);
        this.database.exec("COMMIT");
      } catch (error) {
        if (this.database.isTransaction) {
          this.database.exec("ROLLBACK");
        }
        throw error;
      }
      return {
        sourceFormat: CANDIDATE_STORE_FORMAT,
        targetFormat: CANDIDATE_STORE_FORMAT,
        migrated: true,
      };
    }
    if (userVersion !== CURRENT_USER_VERSION || missingCandidate.length !== 0) {
      throw new PkrError(
        "PKR-MIGRATION-002",
        `partial ${CANDIDATE_STORE_FORMAT} store has user_version ${userVersion} and missing tables: ` +
          (missingCandidate.join(", ") || "none"),
      );
    }
    for (const table of CANDIDATE_TABLES) {
      this.assertTableColumns(table);
    }
    this.validateStore(true);
    return {
      sourceFormat: CANDIDATE_STORE_FORMAT,
      targetFormat: CANDIDATE_STORE_FORMAT,
      migrated: false,
    };
  }

  private applicationTables(): string[] {
    const rows = this.database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as unknown as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  private userVersion(): number {
    const row = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  }

  private assertTableColumns(table: string): void {
    const rows = this.database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string;
    }>;
    const actual = rows.map((row) => row.name);
    const expected = TABLE_COLUMNS[table]!;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new PkrError(
        "PKR-MIGRATION-002",
        `table ${table} has a partial or unsupported column layout`,
      );
    }
  }

  private createCoreSchema(): void {
    this.database.exec(`
      CREATE TABLE metadata(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE records(
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        record_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id, kind, record_id)
      );
      CREATE TABLE events(
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
      CREATE TABLE commands(
        project_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        PRIMARY KEY(project_id, command_id)
      );
    `);
  }

  private createCandidateSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS event_archives(
        project_id TEXT NOT NULL,
        archive_id TEXT NOT NULL,
        first_sequence INTEGER NOT NULL CHECK(first_sequence > 0),
        last_sequence INTEGER NOT NULL CHECK(last_sequence >= first_sequence),
        event_count INTEGER NOT NULL CHECK(event_count > 0),
        events_json TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, archive_id),
        UNIQUE(project_id, first_sequence, last_sequence)
      );
      CREATE TABLE IF NOT EXISTS external_effects(
        project_id TEXT NOT NULL,
        effect_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        request_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'succeeded', 'failed')),
        result_json TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY(project_id, effect_id),
        CHECK(
          (state = 'pending' AND result_json IS NULL AND completed_at IS NULL) OR
          (state != 'pending' AND result_json IS NOT NULL AND completed_at IS NOT NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS repository_evidence(
        project_id TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        adapter TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, content_digest)
      );
    `);
  }

  private validateStore(candidate: boolean): void {
    const quickCheck = this.database.prepare("PRAGMA quick_check").get() as {
      quick_check: string;
    };
    if (quickCheck.quick_check !== "ok") {
      throw new PkrError("PKR-MIGRATION-004", `SQLite quick_check failed: ${quickCheck.quick_check}`);
    }
    const projectSources = [
      "SELECT project_id FROM records",
      "SELECT project_id FROM events",
      "SELECT project_id FROM commands",
      ...(candidate
        ? [
            "SELECT project_id FROM event_archives",
            "SELECT project_id FROM external_effects",
            "SELECT project_id FROM repository_evidence",
          ]
        : []),
    ];
    const projectRows = this.database
      .prepare(`SELECT DISTINCT project_id FROM (${projectSources.join(" UNION ALL ")}) ORDER BY project_id`)
      .all() as unknown as Array<{ project_id: string }>;
    if (projectRows.length > 1) {
      throw new PkrError("PKR-MIGRATION-003", "stale store contains more than one Project authority");
    }
    const recordCount = this.database.prepare("SELECT COUNT(*) AS count FROM records").get() as {
      count: number;
    };
    const manifestCount = this.database
      .prepare("SELECT COUNT(*) AS count FROM records WHERE kind = 'ProjectManifest'")
      .get() as { count: number };
    if (projectRows.length === 1 && (recordCount.count === 0 || manifestCount.count !== 1)) {
      throw new PkrError(
        "PKR-MIGRATION-003",
        "stale store data requires exactly one ProjectManifest authority",
      );
    }
    const metadataSequence = this.database
      .prepare("SELECT value FROM metadata WHERE key = 'project_sequence'")
      .get() as { value: string } | undefined;
    const eventSummary = this.database
      .prepare(
        "SELECT COUNT(*) AS count, COALESCE(MIN(sequence), 0) AS minimum, " +
          "COALESCE(MAX(sequence), 0) AS maximum FROM events",
      )
      .get() as { count: number; minimum: number; maximum: number };
    if (
      !Number.isInteger(eventSummary.count) ||
      !Number.isInteger(eventSummary.maximum) ||
      (eventSummary.count > 0 && !candidate && (
        eventSummary.minimum !== 1 ||
        eventSummary.count !== eventSummary.maximum
      )) ||
      (eventSummary.count > 0 && Number(metadataSequence?.value) !== eventSummary.maximum)
    ) {
      throw new PkrError("PKR-MIGRATION-003", "stale project_sequence does not match live events");
    }
    for (const row of this.database.prepare("SELECT data_json FROM records").all() as unknown as Array<{ data_json: string }>) {
      parseStoredJson(row.data_json, "record");
    }
    for (const row of this.database.prepare("SELECT data_json FROM events").all() as unknown as Array<{ data_json: string }>) {
      parseStoredJson(row.data_json, "event");
    }
    for (const row of this.database.prepare("SELECT result_json FROM commands").all() as unknown as Array<{ result_json: string }>) {
      parseStoredJson(row.result_json, "command result");
    }
    if (candidate) {
      for (const row of this.database.prepare("SELECT request_json, result_json FROM external_effects").all() as unknown as Array<{ request_json: string; result_json: string | null }>) {
        parseStoredJson(row.request_json, "external effect request");
        if (row.result_json !== null) {
          parseStoredJson(row.result_json, "external effect result");
        }
      }
      for (const row of this.database.prepare(
        "SELECT content_digest, adapter, byte_length, payload_json, created_at FROM repository_evidence",
      ).all() as unknown as RepositoryEvidenceRow[]) {
        this.rowToRepositoryEvidence(row);
      }
      const projectId = projectRows[0]?.project_id;
      if (projectId) {
        const logicalEvents = this.listEvents(projectId);
        if (
          logicalEvents.length > 0 &&
          (logicalEvents[0]!.sequence !== 1 ||
            logicalEvents.at(-1)!.sequence !== Number(metadataSequence?.value))
        ) {
          throw new PkrError("PKR-MIGRATION-003", "stale event history is not contiguous from sequence 1");
        }
        for (const ref of this.repositoryEvidenceRefs(projectId)) {
          this.resolveRepositoryEvidence(projectId, ref);
        }
      }
    }
  }

  close(): void {
    this.database.close();
  }

  format(): typeof CANDIDATE_STORE_FORMAT {
    return CANDIDATE_STORE_FORMAT;
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

  beginExternalEffect(
    projectId: string,
    effectId: string,
    assignmentId: string,
    request: JsonObject,
    repositoryEvidence: JsonObject[] = [],
    repositoryEvidenceRefs: RepositoryEvidenceRef[] = [],
  ): { effect: ExternalEffect; execute: boolean } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const transaction = new StoreTransaction(this.database, projectId, effectId);
      for (const evidence of repositoryEvidence) {
        transaction.putRepositoryEvidence(evidence);
      }
      for (const ref of repositoryEvidenceRefs) {
        this.resolveRepositoryEvidence(projectId, ref);
      }
      const reserved = transaction.reserveExternalEffect(effectId, assignmentId, request);
      this.database.exec("COMMIT");
      return reserved;
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  finishExternalEffect(
    projectId: string,
    effectId: string,
    state: Exclude<ExternalEffectState, "pending">,
    result: JsonObject,
    repositoryEvidence: JsonObject[] = [],
    repositoryEvidenceRefs: RepositoryEvidenceRef[] = [],
  ): { effect: ExternalEffect; changed: boolean } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const transaction = new StoreTransaction(this.database, projectId, effectId);
      for (const evidence of repositoryEvidence) {
        transaction.putRepositoryEvidence(evidence);
      }
      for (const ref of repositoryEvidenceRefs) {
        this.resolveRepositoryEvidence(projectId, ref);
      }
      const completed = transaction.completeExternalEffect(effectId, state, result);
      this.database.exec("COMMIT");
      return completed;
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  replayCandidates<T extends JsonValue>(
    projectId: string,
    commandId: string,
    contents: JsonObject[],
  ): CommandResult<T> | undefined {
    const existing = this.database
      .prepare(
        "SELECT digest, result_json FROM commands WHERE project_id = ? AND command_id = ?",
      )
      .get(projectId, commandId) as CommandRow | undefined;
    if (!existing) {
      return undefined;
    }
    if (!contents.some((content) => existing.digest === sha256(content))) {
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
    const archived = this.database
      .prepare(
        "SELECT project_id, archive_id, first_sequence, last_sequence, event_count, events_json, " +
          "content_digest, created_at FROM event_archives WHERE project_id = ? " +
          "AND last_sequence > ? ORDER BY first_sequence",
      )
      .all(projectId, afterSequence) as unknown as ArchiveRow[];
    const archivedEvents = archived.flatMap((row) => {
      const parsed = parseStoredJson(row.events_json, `event archive ${row.archive_id}`);
      if (!Array.isArray(parsed)) {
        throw new PkrError("PKR-RECOVERY-002", `event archive ${row.archive_id} is not an array`);
      }
      if (
        sha256(parsed) !== row.content_digest ||
        parsed.length !== row.event_count ||
        (parsed[0] as RuntimeEvent | undefined)?.sequence !== row.first_sequence ||
        (parsed.at(-1) as RuntimeEvent | undefined)?.sequence !== row.last_sequence
      ) {
        throw new PkrError("PKR-RECOVERY-002", `event archive ${row.archive_id} failed integrity checks`);
      }
      return (parsed as unknown as RuntimeEvent[]).filter((event) => event.sequence > afterSequence);
    });
    const rows = this.database
      .prepare(
        "SELECT project_id, sequence, event_id, type, subject_kind, subject_id, " +
          "subject_revision, command_id, occurred_at, data_json FROM events " +
          "WHERE project_id = ? AND sequence > ? ORDER BY sequence",
      )
      .all(projectId, afterSequence) as unknown as EventRow[];
    const liveEvents = rows.map((row) => ({
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
    const combined = [...archivedEvents, ...liveEvents].sort((left, right) => left.sequence - right.sequence);
    for (let index = 1; index < combined.length; index += 1) {
      if (combined[index]!.sequence !== combined[index - 1]!.sequence + 1) {
        throw new PkrError("PKR-RECOVERY-002", "event archive/live history has a gap or overlap");
      }
    }
    return combined;
  }

  projectionRecords(projectId: string): StoredRecord[] {
    return this.listRecords(projectId).map((record) => ({
      ...record,
      data: replaceRawRepositoryEvidence(record.data, repositoryEvidenceRef) as JsonObject,
    }));
  }

  projectionEvents(projectId: string): RuntimeEvent[] {
    return this.listEvents(projectId).map((event) => ({
      ...event,
      data: replaceRawRepositoryEvidence(event.data, repositoryEvidenceRef) as JsonObject,
    }));
  }

  listRepositoryEvidence(projectId: string): StoredRepositoryEvidence[] {
    const rows = this.database
      .prepare(
        "SELECT content_digest, adapter, byte_length, payload_json, created_at " +
          "FROM repository_evidence WHERE project_id = ? ORDER BY content_digest",
      )
      .all(projectId) as unknown as RepositoryEvidenceRow[];
    return rows.map((row) => this.rowToRepositoryEvidence(row));
  }

  projectionRepositoryEvidence(projectId: string): StoredRepositoryEvidence[] {
    const byDigest = new Map(
      this.listRepositoryEvidence(projectId).map((item) => [item.ref.contentDigest, item]),
    );
    const collect = (value: JsonValue): void => {
      const raw = findRawRepositoryEvidenceValues(value);
      for (const evidence of raw) {
        const ref = repositoryEvidenceRef(evidence);
        if (!byDigest.has(ref.contentDigest)) {
          byDigest.set(ref.contentDigest, {
            ref,
            content: repositoryEvidenceContent(evidence),
            createdAt: typeof evidence.collectedAt === "string" ? evidence.collectedAt : "legacy",
          });
        }
      }
    };
    for (const record of this.listRecords(projectId)) {
      collect(record.data);
    }
    for (const event of this.listEvents(projectId)) {
      collect(event.data);
    }
    return [...byDigest.values()].sort((left, right) =>
      left.ref.contentDigest.localeCompare(right.ref.contentDigest)
    );
  }

  resolveRepositoryEvidence(
    projectId: string,
    refValue: JsonObject,
  ): JsonObject {
    const ref = assertRepositoryEvidenceRef(refValue);
    const row = this.database
      .prepare(
        "SELECT content_digest, adapter, byte_length, payload_json, created_at " +
          "FROM repository_evidence WHERE project_id = ? AND content_digest = ?",
      )
      .get(projectId, ref.contentDigest) as RepositoryEvidenceRow | undefined;
    const legacy = row ? undefined : this.findLegacyRepositoryEvidence(projectId, ref.contentDigest);
    if (!row && !legacy) {
      throw new PkrError(
        "PKR-EVIDENCE-003",
        `RepositoryEvidence ${ref.contentDigest} is not present in Runtime authority`,
      );
    }
    const stored = row
      ? this.rowToRepositoryEvidence(row)
      : {
          ref: repositoryEvidenceRef(legacy!),
          content: repositoryEvidenceContent(legacy!),
          createdAt: legacy!.collectedAt as string ?? "legacy",
        };
    if (
      stored.ref.adapter !== ref.adapter ||
      stored.ref.byteLength !== ref.byteLength
    ) {
      throw new PkrError(
        "PKR-EVIDENCE-002",
        `RepositoryEvidenceRef conflicts with Runtime authority for ${ref.contentDigest}`,
      );
    }
    const observation = ref.observation;
    if (
      (ref.head !== undefined && ref.head !== stored.content.head) ||
      (ref.changedFiles !== undefined &&
        stableStringify(ref.changedFiles) !== stableStringify(stored.content.changedFiles)) ||
      (ref.clean !== undefined && ref.clean !== (stored.content.changedFiles.length === 0))
    ) {
      throw new PkrError(
        "PKR-EVIDENCE-002",
        `RepositoryEvidenceRef summary conflicts with Runtime authority for ${ref.contentDigest}`,
      );
    }
    return {
      adapter: ref.adapter,
      ...(typeof observation?.repositoryRoot === "string"
        ? { repositoryRoot: observation.repositoryRoot }
        : {}),
      ...stored.content,
      clean: ref.clean ?? stored.content.changedFiles.length === 0,
      contentDigest: ref.contentDigest,
      ...(typeof observation?.collectedAt === "string"
        ? { collectedAt: observation.collectedAt }
        : {}),
    };
  }

  stateDigest(projectId: string): string {
    const content: JsonObject = {
      records: this.listRecords(projectId).map((record) => ({
        kind: record.kind,
        id: record.id,
        revision: record.revision,
        data: record.data,
      })),
      events: this.listEvents(projectId) as unknown as JsonValue,
    };
    const repositoryEvidence = this.listRepositoryEvidence(projectId);
    if (repositoryEvidence.length) {
      content.repositoryEvidence = repositoryEvidence.map((item) =>
        stableRepositoryEvidenceRef(item.ref)
      );
    }
    return sha256(content);
  }

  exportState(projectId: string): JsonObject {
    return {
      projectId,
      records: this.projectionRecords(projectId) as unknown as JsonValue,
      events: this.projectionEvents(projectId) as unknown as JsonValue,
      repositoryEvidence: this.projectionRepositoryEvidence(projectId).map((item) => item.ref) as unknown as JsonValue,
      digest: this.stateDigest(projectId),
    };
  }

  getExternalEffect(projectId: string, effectId: string): ExternalEffect | undefined {
    const row = this.database
      .prepare(
        "SELECT project_id, effect_id, assignment_id, request_digest, request_json, state, " +
          "result_json, created_at, completed_at FROM external_effects " +
          "WHERE project_id = ? AND effect_id = ?",
      )
      .get(projectId, effectId) as ExternalEffectRow | undefined;
    return row ? rowToExternalEffect(row) : undefined;
  }

  listExternalEffects(projectId: string, assignmentId?: string): ExternalEffect[] {
    const rows = (assignmentId
      ? this.database
          .prepare(
            "SELECT project_id, effect_id, assignment_id, request_digest, request_json, state, " +
              "result_json, created_at, completed_at FROM external_effects " +
              "WHERE project_id = ? AND assignment_id = ? ORDER BY effect_id",
          )
          .all(projectId, assignmentId)
      : this.database
          .prepare(
            "SELECT project_id, effect_id, assignment_id, request_digest, request_json, state, " +
              "result_json, created_at, completed_at FROM external_effects " +
              "WHERE project_id = ? ORDER BY effect_id",
          )
          .all(projectId)) as unknown as ExternalEffectRow[];
    return rows.map(rowToExternalEffect);
  }

  compact(projectId: string, policy: RetentionPolicy): CompactionResult {
    if (
      !Number.isInteger(policy.keepRecentEvents) ||
      policy.keepRecentEvents < 1 ||
      policy.auditGuarantee !== "full-replay"
    ) {
      throw new PkrError(
        "PKR-RETENTION-001",
        "retention requires keepRecentEvents >= 1 and the full-replay audit guarantee",
      );
    }
    const stateDigestBefore = this.stateDigest(projectId);
    const allEvents = this.listEvents(projectId);
    const liveCount = this.database
      .prepare("SELECT COUNT(*) AS count FROM events WHERE project_id = ?")
      .get(projectId) as { count: number };
    const archiveCount = Math.max(0, liveCount.count - policy.keepRecentEvents);
    if (archiveCount === 0) {
      return {
        projectId,
        archiveId: null,
        archivedEvents: 0,
        liveEvents: liveCount.count,
        firstArchivedSequence: null,
        lastArchivedSequence: null,
        stateDigestBefore,
        stateDigestAfter: stateDigestBefore,
        policy,
      };
    }
    const liveRows = this.database
      .prepare(
        "SELECT project_id, sequence, event_id, type, subject_kind, subject_id, " +
          "subject_revision, command_id, occurred_at, data_json FROM events " +
          "WHERE project_id = ? ORDER BY sequence LIMIT ?",
      )
      .all(projectId, archiveCount) as unknown as EventRow[];
    const events = liveRows.map(rowToEvent);
    const firstSequence = events[0]!.sequence;
    const lastSequence = events.at(-1)!.sequence;
    const archiveId = `archive_${firstSequence}_${lastSequence}_${sha256(events).slice(0, 16)}`;
    const createdAt = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          "INSERT INTO event_archives(project_id, archive_id, first_sequence, last_sequence, " +
            "event_count, events_json, content_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          projectId,
          archiveId,
          firstSequence,
          lastSequence,
          events.length,
          JSON.stringify(events),
          sha256(events),
          createdAt,
        );
      if (process.env.PKR_FAILPOINT === "compaction-after-archive") {
        throw new Error("PKR failpoint compaction-after-archive");
      }
      this.database
        .prepare("DELETE FROM events WHERE project_id = ? AND sequence BETWEEN ? AND ?")
        .run(projectId, firstSequence, lastSequence);
      this.database
        .prepare(
          "INSERT INTO metadata(key, value) VALUES ('retention_policy', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(JSON.stringify(policy));
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
    const stateDigestAfter = this.stateDigest(projectId);
    if (stateDigestAfter !== stateDigestBefore || this.listEvents(projectId).length !== allEvents.length) {
      throw new PkrError("PKR-RECOVERY-002", "compaction changed replayable state");
    }
    return {
      projectId,
      archiveId,
      archivedEvents: events.length,
      liveEvents: liveCount.count - events.length,
      firstArchivedSequence: firstSequence,
      lastArchivedSequence: lastSequence,
      stateDigestBefore,
      stateDigestAfter,
      policy,
    };
  }

  createSnapshot(projectId: string, targetPath: string): StoreSnapshot {
    if (existsSync(targetPath)) {
      throw new PkrError("PKR-RECOVERY-001", "snapshot target already exists");
    }
    const retentionPolicy = this.retentionPolicy();
    const commands = this.snapshotCommands(projectId);
    const payload: SnapshotPayload = {
      snapshotFormat: SNAPSHOT_FORMAT,
      storeFormat: CANDIDATE_STORE_FORMAT,
      projectId,
      createdAt: now(),
      projectSequence: this.listEvents(projectId).at(-1)?.sequence ?? 0,
      stateDigest: this.stateDigest(projectId),
      records: this.listRecords(projectId),
      events: this.listEvents(projectId),
      commands,
      externalEffects: this.listExternalEffects(projectId),
      repositoryEvidence: this.listRepositoryEvidence(projectId),
      retentionPolicy,
    };
    const snapshot: StoreSnapshot = { ...payload, checksum: sha256(payload) };
    mkdirSync(dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.tmp-${process.pid}`;
    writeFileSync(temporaryPath, `${stableStringify(snapshot)}\n`, { encoding: "utf8", flag: "wx" });
    if (process.env.PKR_FAILPOINT === "snapshot-before-rename") {
      rmSync(temporaryPath, { force: true });
      throw new Error("PKR failpoint snapshot-before-rename");
    }
    renameSync(temporaryPath, targetPath);
    return snapshot;
  }

  static readSnapshot(snapshotPath: string): StoreSnapshot {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(snapshotPath, "utf8"));
    } catch (error) {
      throw new PkrError(
        "PKR-RECOVERY-002",
        `cannot read snapshot: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const snapshot = parsed as StoreSnapshot;
    if (
      snapshot?.snapshotFormat !== SNAPSHOT_FORMAT ||
      snapshot.storeFormat !== CANDIDATE_STORE_FORMAT ||
      !snapshot.projectId ||
      !Array.isArray(snapshot.records) ||
      !Array.isArray(snapshot.events) ||
      !Array.isArray(snapshot.commands) ||
      !Array.isArray(snapshot.externalEffects) ||
      (snapshot.repositoryEvidence !== undefined && !Array.isArray(snapshot.repositoryEvidence)) ||
      typeof snapshot.checksum !== "string"
    ) {
      throw new PkrError("PKR-RECOVERY-002", "unsupported or partial snapshot");
    }
    const { checksum, ...payload } = snapshot;
    if (sha256(payload) !== checksum) {
      throw new PkrError("PKR-RECOVERY-002", "snapshot checksum mismatch");
    }
    validateSnapshot(snapshot);
    return snapshot;
  }

  static restoreSnapshot(snapshotPath: string, databasePath: string): StoreSnapshot {
    const snapshot = PkrStore.readSnapshot(snapshotPath);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(`${databasePath}${suffix}`)) {
        throw new PkrError(
          "PKR-RECOVERY-004",
          "restore target already contains authority; refusing a potentially stale overwrite",
        );
      }
    }
    const temporaryPath = `${databasePath}.restore-${process.pid}`;
    let store: PkrStore | undefined;
    try {
      store = new PkrStore(temporaryPath);
      store.restoreSnapshotData(snapshot);
      store.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      store.close();
      store = undefined;
      if (process.env.PKR_FAILPOINT === "restore-before-rename") {
        throw new Error("PKR failpoint restore-before-rename");
      }
      renameSync(temporaryPath, databasePath);
      const verified = new PkrStore(databasePath);
      try {
        if (
          verified.stateDigest(snapshot.projectId) !== snapshot.stateDigest ||
          sha256(verified.snapshotCommands(snapshot.projectId)) !== sha256(snapshot.commands) ||
          sha256(verified.listExternalEffects(snapshot.projectId)) !== sha256(snapshot.externalEffects) ||
          sha256(verified.listRepositoryEvidence(snapshot.projectId)) !==
            sha256(snapshot.repositoryEvidence ?? []) ||
          sha256(verified.retentionPolicy()) !== sha256(snapshot.retentionPolicy)
        ) {
          throw new PkrError("PKR-RECOVERY-002", "restored authority or journals do not match snapshot");
        }
      } finally {
        verified.close();
      }
      return snapshot;
    } catch (error) {
      store?.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${temporaryPath}${suffix}`, { force: true });
      }
      throw error;
    }
  }

  exportPublicAlpha(projectId: string, targetPath: string): void {
    if (
      this.listRepositoryEvidence(projectId).length !== 0 ||
      this.repositoryEvidenceRefs(projectId).length !== 0
    ) {
      throw new PkrError(
        "PKR-MIGRATION-005",
        "downgrade cannot represent content-addressed RepositoryEvidence references",
      );
    }
    if (this.listExternalEffects(projectId).length !== 0) {
      throw new PkrError(
        "PKR-MIGRATION-005",
        "downgrade cannot represent external effect journal entries",
      );
    }
    const archives = this.database
      .prepare("SELECT COUNT(*) AS count FROM event_archives WHERE project_id = ?")
      .get(projectId) as { count: number };
    if (archives.count !== 0) {
      throw new PkrError(
        "PKR-MIGRATION-005",
        "downgrade requires a non-compacted store because public alpha has no archive table",
      );
    }
    if (["", "-wal", "-shm"].some((suffix) => existsSync(`${targetPath}${suffix}`))) {
      throw new PkrError("PKR-MIGRATION-005", "downgrade target already exists");
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    const target = new DatabaseSync(targetPath);
    try {
      target.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
      target.exec(`
        CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE records(
          project_id TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision > 0), data_json TEXT NOT NULL,
          updated_at TEXT NOT NULL, PRIMARY KEY(project_id, kind, record_id)
        );
        CREATE TABLE events(
          project_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence > 0),
          event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, subject_kind TEXT NOT NULL,
          subject_id TEXT NOT NULL, subject_revision INTEGER NOT NULL CHECK(subject_revision > 0),
          command_id TEXT NOT NULL, occurred_at TEXT NOT NULL, data_json TEXT NOT NULL,
          PRIMARY KEY(project_id, sequence)
        );
        CREATE TABLE commands(
          project_id TEXT NOT NULL, command_id TEXT NOT NULL, digest TEXT NOT NULL,
          result_json TEXT NOT NULL, committed_at TEXT NOT NULL,
          PRIMARY KEY(project_id, command_id)
        );
      `);
      copyRows(this.database, target, "metadata", ["key", "value"], "key != 'store_format' AND key != 'retention_policy'");
      copyRows(this.database, target, "records", ["project_id", "kind", "record_id", "revision", "data_json", "updated_at"]);
      copyRows(this.database, target, "events", ["project_id", "sequence", "event_id", "type", "subject_kind", "subject_id", "subject_revision", "command_id", "occurred_at", "data_json"]);
      copyRows(this.database, target, "commands", ["project_id", "command_id", "digest", "result_json", "committed_at"]);
      if (process.env.PKR_FAILPOINT === "downgrade-before-commit") {
        throw new Error("PKR failpoint downgrade-before-commit");
      }
      target.exec("COMMIT");
    } catch (error) {
      if (target.isTransaction) {
        target.exec("ROLLBACK");
      }
      target.close();
      rmSync(targetPath, { force: true });
      throw error;
    }
    target.close();
  }

  private retentionPolicy(): RetentionPolicy | null {
    const row = this.database
      .prepare("SELECT value FROM metadata WHERE key = 'retention_policy'")
      .get() as { value: string } | undefined;
    return row ? (parseStoredJson(row.value, "retention policy") as unknown as RetentionPolicy) : null;
  }

  private snapshotCommands(projectId: string): SnapshotCommand[] {
    const commands = this.database
      .prepare(
        "SELECT project_id, command_id, digest, result_json, committed_at FROM commands " +
          "WHERE project_id = ? ORDER BY committed_at, command_id",
      )
      .all(projectId) as unknown as CommandRow[];
    return commands.map((row) => ({
      projectId: row.project_id,
      commandId: row.command_id,
      digest: row.digest,
      result: parseStoredJson(row.result_json, `command ${row.command_id}`) as JsonObject,
      committedAt: row.committed_at,
    }));
  }

  private repositoryEvidenceRefs(projectId: string): RepositoryEvidenceRef[] {
    const values: JsonValue[] = [
      ...this.listRecords(projectId).map((record) => record.data),
      ...this.listEvents(projectId).map((event) => event.data),
      ...this.snapshotCommands(projectId).map((command) => command.result),
      ...this.listExternalEffects(projectId).flatMap((effect) =>
        effect.result === null ? [effect.request] : [effect.request, effect.result]
      ),
    ];
    return values.flatMap((value) => collectRepositoryEvidenceRefs(value));
  }

  private restoreSnapshotData(snapshot: StoreSnapshot): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const insertRecord = this.database.prepare(
        "INSERT INTO records(project_id, kind, record_id, revision, data_json, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const record of snapshot.records) {
        insertRecord.run(
          record.projectId,
          record.kind,
          record.id,
          record.revision,
          JSON.stringify(record.data),
          record.updatedAt,
        );
      }
      const insertEvent = this.database.prepare(
        "INSERT INTO events(project_id, sequence, event_id, type, subject_kind, subject_id, " +
          "subject_revision, command_id, occurred_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const event of snapshot.events) {
        insertEvent.run(
          event.projectId,
          event.sequence,
          event.eventId,
          event.type,
          event.subjectKind,
          event.subjectId,
          event.subjectRevision,
          event.commandId,
          event.occurredAt,
          JSON.stringify(event.data),
        );
      }
      const insertCommand = this.database.prepare(
        "INSERT INTO commands(project_id, command_id, digest, result_json, committed_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const command of snapshot.commands) {
        insertCommand.run(
          command.projectId,
          command.commandId,
          command.digest,
          JSON.stringify(command.result),
          command.committedAt,
        );
      }
      const insertEffect = this.database.prepare(
        "INSERT INTO external_effects(project_id, effect_id, assignment_id, request_digest, " +
          "request_json, state, result_json, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const effect of snapshot.externalEffects) {
        insertEffect.run(
          effect.projectId,
          effect.effectId,
          effect.assignmentId,
          effect.requestDigest,
          JSON.stringify(effect.request),
          effect.state,
          effect.result === null ? null : JSON.stringify(effect.result),
          effect.createdAt,
          effect.completedAt,
        );
      }
      const insertEvidence = this.database.prepare(
        "INSERT INTO repository_evidence(project_id, content_digest, adapter, byte_length, " +
          "payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const evidence of snapshot.repositoryEvidence ?? []) {
        insertEvidence.run(
          snapshot.projectId,
          evidence.ref.contentDigest,
          evidence.ref.adapter,
          evidence.ref.byteLength,
          stableStringify(evidence.content),
          evidence.createdAt,
        );
      }
      this.database
        .prepare(
          "INSERT INTO metadata(key, value) VALUES ('project_sequence', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(snapshot.projectSequence));
      if (snapshot.retentionPolicy) {
        this.database
          .prepare("INSERT INTO metadata(key, value) VALUES ('retention_policy', ?)")
          .run(JSON.stringify(snapshot.retentionPolicy));
      }
      if (process.env.PKR_FAILPOINT === "restore-after-data") {
        throw new Error("PKR failpoint restore-after-data");
      }
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }
  private rowToRepositoryEvidence(row: RepositoryEvidenceRow): StoredRepositoryEvidence {
    const content = JSON.parse(row.payload_json) as JsonObject;
    const ref = {
      refVersion: "pkr.repository-evidence-ref/v1",
      adapter: row.adapter,
      contentDigest: row.content_digest,
      byteLength: row.byte_length,
    } as RepositoryEvidenceRef;
    assertRepositoryEvidenceRef(ref);
    const normalized = repositoryEvidenceContent({ adapter: row.adapter, ...content });
    if (
      digest(normalized) !== ref.contentDigest ||
      Buffer.byteLength(stableStringify(normalized), "utf8") !== ref.byteLength
    ) {
      throw new PkrError(
        "PKR-EVIDENCE-002",
        `RepositoryEvidence payload integrity check failed for ${ref.contentDigest}`,
      );
    }
    return { ref, content: normalized, createdAt: row.created_at };
  }

  private findLegacyRepositoryEvidence(
    projectId: string,
    contentDigest: string,
  ): JsonObject | undefined {
    for (const record of this.listRecords(projectId)) {
      const found = findRawRepositoryEvidence(record.data, contentDigest);
      if (found) {
        return found;
      }
    }
    for (const event of this.listEvents(projectId)) {
      const found = findRawRepositoryEvidence(event.data, contentDigest);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
}

function findRawRepositoryEvidenceValues(value: JsonValue): JsonObject[] {
  const found: JsonObject[] = [];
  const visit = (candidate: JsonValue): void => {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const evidence = candidate as JsonObject;
      if (
        evidence.adapter === "pkr.git-workspace/v1" &&
        typeof evidence.diff === "string" &&
        typeof evidence.stagedDiff === "string"
      ) {
        found.push(evidence);
        return;
      }
      for (const child of Object.values(evidence)) {
        visit(child as JsonValue);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
    }
  };
  visit(value);
  return found;
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

function rowToEvent(row: EventRow): RuntimeEvent {
  return {
    projectId: row.project_id,
    sequence: row.sequence,
    eventId: row.event_id,
    type: row.type,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    subjectRevision: row.subject_revision,
    commandId: row.command_id,
    occurredAt: row.occurred_at,
    data: parseStoredJson(row.data_json, `event ${row.event_id}`) as JsonObject,
  };
}

function rowToExternalEffect(row: ExternalEffectRow): ExternalEffect {
  return {
    projectId: row.project_id,
    effectId: row.effect_id,
    assignmentId: row.assignment_id,
    requestDigest: row.request_digest,
    request: parseStoredJson(row.request_json, `external effect ${row.effect_id} request`) as JsonObject,
    state: row.state,
    result: row.result_json === null
      ? null
      : parseStoredJson(row.result_json, `external effect ${row.effect_id} result`) as JsonObject,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function parseStoredJson(text: string, label: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new PkrError(
      "PKR-MIGRATION-004",
      `${label} contains corrupt JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateSnapshot(snapshot: StoreSnapshot): void {
  if (
    !Number.isInteger(snapshot.projectSequence) ||
    snapshot.projectSequence < 0 ||
    typeof snapshot.stateDigest !== "string" ||
    !Number.isFinite(Date.parse(snapshot.createdAt))
  ) {
    throw new PkrError("PKR-RECOVERY-002", "snapshot metadata is invalid");
  }
  for (const record of snapshot.records) {
    if (
      record.projectId !== snapshot.projectId ||
      !record.kind ||
      !record.id ||
      !Number.isInteger(record.revision) ||
      record.revision < 1 ||
      record.data?.kind !== record.kind ||
      !Number.isFinite(Date.parse(record.updatedAt))
    ) {
      throw new PkrError("PKR-RECOVERY-002", "snapshot contains an invalid record");
    }
  }
  for (let index = 0; index < snapshot.events.length; index += 1) {
    const event = snapshot.events[index]!;
    if (
      event.projectId !== snapshot.projectId ||
      event.sequence !== index + 1 ||
      !event.eventId ||
      !event.commandId ||
      !Number.isInteger(event.subjectRevision) ||
      event.subjectRevision < 1 ||
      !Number.isFinite(Date.parse(event.occurredAt))
    ) {
      throw new PkrError("PKR-RECOVERY-002", "snapshot event history is partial or non-contiguous");
    }
  }
  if ((snapshot.events.at(-1)?.sequence ?? 0) !== snapshot.projectSequence) {
    throw new PkrError("PKR-RECOVERY-002", "snapshot project sequence does not match its events");
  }
  for (const command of snapshot.commands) {
    if (
      command.projectId !== snapshot.projectId ||
      !command.commandId ||
      !command.digest ||
      !Number.isFinite(Date.parse(command.committedAt))
    ) {
      throw new PkrError("PKR-RECOVERY-002", "snapshot contains an invalid command replay entry");
    }
  }
  for (const effect of snapshot.externalEffects) {
    if (
      effect.projectId !== snapshot.projectId ||
      !effect.effectId ||
      !effect.assignmentId ||
      effect.requestDigest !== sha256(effect.request) ||
      (effect.state === "pending" && (effect.result !== null || effect.completedAt !== null)) ||
      (effect.state !== "pending" && (effect.result === null || !effect.completedAt))
    ) {
      throw new PkrError("PKR-RECOVERY-002", "snapshot contains an invalid external effect entry");
    }
  }
  const repositoryEvidence = snapshot.repositoryEvidence ?? [];
  let previousDigest = "";
  for (const evidence of repositoryEvidence) {
    const ref = assertRepositoryEvidenceRef(evidence.ref);
    const stableRef = stableRepositoryEvidenceRef(ref);
    const content = repositoryEvidenceContent({ adapter: ref.adapter, ...evidence.content });
    if (
      stableStringify(ref) !== stableStringify(stableRef) ||
      digest(content) !== ref.contentDigest ||
      Buffer.byteLength(stableStringify(content), "utf8") !== ref.byteLength ||
      !Number.isFinite(Date.parse(evidence.createdAt)) ||
      ref.contentDigest <= previousDigest
    ) {
      throw new PkrError("PKR-RECOVERY-002", "snapshot contains invalid RepositoryEvidence");
    }
    previousDigest = ref.contentDigest;
  }
  const logicalState: JsonObject = {
    records: snapshot.records.map((record) => ({
      kind: record.kind,
      id: record.id,
      revision: record.revision,
      data: record.data,
    })) as unknown as JsonValue,
    events: snapshot.events as unknown as JsonValue,
  };
  if (repositoryEvidence.length !== 0) {
    logicalState.repositoryEvidence = repositoryEvidence.map((evidence) =>
      stableRepositoryEvidenceRef(evidence.ref)
    ) as unknown as JsonValue;
  }
  const logicalDigest = sha256(logicalState);
  if (logicalDigest !== snapshot.stateDigest) {
    throw new PkrError("PKR-RECOVERY-002", "snapshot logical state digest mismatch");
  }
}

function copyRows(
  source: DatabaseSync,
  target: DatabaseSync,
  table: string,
  columns: string[],
  where?: string,
): void {
  const rows = source
    .prepare(`SELECT ${columns.join(", ")} FROM ${table}${where ? ` WHERE ${where}` : ""}`)
    .all() as unknown as Array<Record<string, string | number | null>>;
  const insert = target.prepare(
    `INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(",")})`,
  );
  for (const row of rows) {
    insert.run(...columns.map((column) => row[column] ?? null));
  }
}

export function commandContent(value: JsonObject): JsonObject {
  return JSON.parse(stableStringify(value)) as JsonObject;
}
