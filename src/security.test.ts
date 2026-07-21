import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { resolveSafeRepositoryPath } from "./path-safety.js";
import { runBoundedProcess } from "./process.js";
import {
  createDiagnosticExport,
  isBoundedCallbackPayload,
  isSafeOutputLocator,
  redactDiagnosticValue,
  redactSensitiveText,
  sanitizeProcessResult,
} from "./security.js";
import type { JsonObject, RuntimeEvent, StoredRecord } from "./types.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

test("bounded process caps retained output and input before they exhaust memory", async () => {
  const output = await runBoundedProcess({
    executable: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.alloc(128 * 1024, 65))"],
    cwd: process.cwd(),
    maxOutputBytes: 1_024,
  });
  assert.equal(output.failureReason, "OutputLimitExceeded");
  assert.equal(output.outputTruncated, true);
  assert.ok(Buffer.byteLength(output.stdout, "utf8") <= 1_024);

  const input = await runBoundedProcess({
    executable: process.execPath,
    args: ["-e", "process.stdin.resume()"],
    cwd: process.cwd(),
    input: "x".repeat(2_049),
    maxInputBytes: 2_048,
  });
  assert.equal(input.failureReason, "InputLimitExceeded");
  assert.equal(input.exitCode, null);
});

test("process and diagnostic redaction remove credentials and private machine paths", () => {
  const credential = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
  const privatePath = ["C:", "Users", "private-user", "project"].join("\\");
  const raw = `${["author", "ization"].join("")}: ${["bear", "er"].join("")} ${credential} ` +
    `${["pass", "word"].join("")}=${credential} ${privatePath}`;
  const redacted = redactSensitiveText(raw);
  assert.equal(redacted.includes(credential), false);
  assert.equal(redacted.includes("private-user"), false);

  const processResult = sanitizeProcessResult({
    executable: privatePath,
    args: ["--token", credential, privatePath],
    cwd: privatePath,
    exitCode: 1,
    signal: null,
    stdout: raw,
    stderr: raw,
    timedOut: false,
    outputTruncated: false,
    failureReason: "ExitCode:1",
    startedAt: "2026-07-21T00:00:00.000Z",
    completedAt: "2026-07-21T00:00:00.001Z",
    durationMs: 1,
  });
  assert.equal(JSON.stringify(processResult).includes(credential), false);
  assert.equal(processResult.cwd, "[PROJECT-ROOT]");

  const value = redactDiagnosticValue({ [["pass", "word"].join("")]: credential, nested: { path: privatePath } });
  assert.equal(JSON.stringify(value).includes(credential), false);
  assert.equal(JSON.stringify(value).includes("private-user"), false);
});

test("repository output locators and callback payloads are bounded", () => {
  assert.equal(isSafeOutputLocator("src/result.txt"), true);
  assert.equal(isSafeOutputLocator("pkr://artifacts/result"), true);
  assert.equal(isSafeOutputLocator("../outside.txt"), false);
  assert.equal(isSafeOutputLocator("C:\\outside.txt"), false);
  assert.equal(isSafeOutputLocator("https://example.invalid/result"), false);
  assert.equal(isBoundedCallbackPayload({
    outcome: "partial",
    completed: [],
    incomplete: ["verification"],
    blockers: [],
    evidenceIds: [],
    outputs: [],
    nextAction: "Verify independently.",
  }), true);
  assert.equal(isBoundedCallbackPayload({
    completed: Array.from({ length: 129 }, () => "item"),
    incomplete: [],
    blockers: [],
    evidenceIds: [],
    outputs: [],
    nextAction: "Stop.",
  }), false);
});

test("repository writes reject symbolic-link and junction traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pkr-path-root-"));
  const outside = await mkdtemp(join(tmpdir(), "pkr-path-outside-"));
  temporaryRoots.push(root, outside);
  await mkdir(join(root, "safe"));
  const link = join(root, "linked");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(resolveSafeRepositoryPath(root, "safe/result.txt"), join(root, "safe", "result.txt"));
  assert.throws(
    () => resolveSafeRepositoryPath(root, "linked/escaped.txt"),
    /symbolic link|junction|outside/,
  );
});

test("diagnostic export contains bounded summaries but no record or event bodies", () => {
  const credential = ["secret", "diagnostic-value"].join("-");
  const records: StoredRecord[] = [{
    projectId: "project_private",
    kind: "Task",
    id: "task_private",
    revision: 1,
    updatedAt: "2026-07-21T00:00:00.000Z",
    data: { status: { phase: "backlog" }, privatePrompt: credential },
  }];
  const events: RuntimeEvent[] = [{
    projectId: "project_private",
    sequence: 1,
    eventId: "event_private",
    type: "pkr.task.created",
    subjectKind: "Task",
    subjectId: "task_private",
    subjectRevision: 1,
    commandId: "command_private",
    occurredAt: "2026-07-21T00:00:00.000Z",
    data: { privatePrompt: credential },
  }];
  const report = createDiagnosticExport({
    projectId: "project_private",
    status: () => ({
      projectId: "project_private",
      title: credential,
      phase: "active",
      projectSequence: 1,
      stateDigest: "sha256:test",
      recordCounts: { Task: 1 },
    }),
    listRecords: () => records,
    listEvents: () => events,
  });
  const encoded = JSON.stringify(report);
  assert.equal(encoded.includes(credential), false);
  assert.equal(encoded.includes("task_private"), false);
  assert.equal(encoded.includes("event_private"), false);
  assert.ok(Buffer.byteLength(encoded, "utf8") <= 64 * 1024);
  assert.equal(((report.events as JsonObject).included as number), 1);
});
