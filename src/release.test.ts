import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { JsonObject } from "./types.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(repositoryRoot, "dist", "cli.js");
const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

test("three-command flow records a Codex change, verifies it independently, and recovers status", async () => {
  const project = await fixtureProject(
    "release-success",
    "import { readFileSync } from 'node:fs';\n" +
      "if (readFileSync('answer.ts', 'utf8') !== 'export const answer = 42;\\n') process.exit(9)",
  );
  const fake = await fakeCodex(project, "export const answer = 42;\n");
  const initialized = runCli(project, ["init"]);
  assert.equal((initialized.recordCounts as JsonObject).ProjectManifest, 1);

  const execution = runCli(
    project,
    ["run", "Add answer.ts", "--verify", "node verify.mjs"],
    fake.environment,
  );
  assert.equal(((execution.execution as JsonObject).callback as JsonObject).outcome, "verified");
  assert.equal(
    (((execution.status as JsonObject).summary as JsonObject).state as string),
    "completed",
  );
  assert.equal(await readFile(join(project, "answer.ts"), "utf8"), "export const answer = 42;\n");

  const recovered = runCli(project, ["status"]);
  assert.equal((recovered.summary as JsonObject).state, "completed");
  assert.equal(((recovered.tasks as JsonObject[])[0]?.phase as string), "done");
  assert.equal(((recovered.assignments as JsonObject[])[0]?.state as string), "closed");
  const callback = (recovered.callbacks as JsonObject[])[0]!;
  assert.equal(callback.outcome, "verified");
  assert.equal((callback.evidenceIds as string[]).some((id) => id.includes("verification")), true);
  assert.equal((callback.completed as string[]).includes("independent-tests-passed"), true);
  assert.deepEqual(callback.incomplete, []);

  const runDirectory = join(project, ".pkr", "runs", callback.assignmentId as string);
  assert.match(await readFile(join(runDirectory, "verification.log"), "utf8"), /exit=0/);
  assert.equal(JSON.parse(await readFile(join(runDirectory, "summary.json"), "utf8")).callback.outcome, "verified");
});

test("independent verification failure is durably visible and cannot complete a Task", async () => {
  const project = await fixtureProject("release-failure", "process.exit(7)");
  const fake = await fakeCodex(project, "export const broken = true;\n");
  runCli(project, ["init"]);
  const result = invokeCli(
    project,
    ["run", "Add broken.ts", "--verify", "node verify.mjs"],
    fake.environment,
  );
  assert.equal(result.status, 2, result.stderr || result.stdout);
  const execution = JSON.parse(result.stdout) as JsonObject;
  assert.equal(((execution.execution as JsonObject).callback as JsonObject).outcome, "blocked");

  const recovered = runCli(project, ["status"]);
  assert.equal((recovered.summary as JsonObject).state, "attentionRequired");
  assert.equal(((recovered.tasks as JsonObject[])[0]?.phase as string), "blocked");
  assert.equal((recovered.recordCounts as JsonObject).Verification ?? 0, 0);
  const callback = (recovered.callbacks as JsonObject[])[0]!;
  assert.match((callback.blockers as string[]).join("\n"), /exited with 7/);
});

async function fixtureProject(name: string, verificationBody: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pkr-${name}-`));
  temporaryRoots.push(root);
  await writeFile(join(root, "README.md"), `# ${name}\n`, "utf8");
  await writeFile(join(root, "verify.mjs"), `${verificationBody};\n`, "utf8");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "pkr-test@example.invalid"]);
  git(root, ["config", "user.name", "PKR Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
  return root;
}

async function fakeCodex(
  projectRoot: string,
  content: string,
): Promise<{ environment: NodeJS.ProcessEnv }> {
  const script = join(projectRoot, "fake-codex.mjs");
  const source = `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
writeFileSync("answer.ts", ${JSON.stringify(content)}, "utf8");
writeFileSync(output, JSON.stringify({
  completed: ["implemented answer.ts"],
  incomplete: ["Tests were not run in the Agent session."],
  blockers: [],
  nextAction: "verify"
}), "utf8");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message" } }) + "\\n");
`;
  await writeFile(script, source, "utf8");
  await chmod(script, 0o755);
  return {
    environment: {
      ...process.env,
      PKR_CODEX_COMMAND: process.execPath,
      PKR_CODEX_ARGS: JSON.stringify([script]),
    },
  };
}

function invokeCli(
  projectRoot: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
) {
  return spawnSync(process.execPath, [cli, ...args, "--project", projectRoot], {
    encoding: "utf8",
    env: environment,
  });
}

function runCli(
  projectRoot: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): JsonObject {
  const result = invokeCli(projectRoot, args, environment);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as JsonObject;
}

function git(root: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
