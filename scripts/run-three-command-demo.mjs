import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "examples", "three-command-demo", "fixture");
const target = process.argv[2]
  ? resolve(process.argv[2])
  : await mkdtemp(join(tmpdir(), "pkr-three-command-demo-"));
await mkdir(target, { recursive: true });
await cp(fixture, target, { recursive: true, force: false });

run("git", ["init", "-b", "main"], target);
run("git", ["config", "user.email", "pkr-demo@example.invalid"], target);
run("git", ["config", "user.name", "PKR Demo"], target);
run("git", ["add", "."], target);
run("git", ["commit", "-m", "demo baseline"], target);

const cli = join(root, "dist", "cli.js");
const startedAt = Date.now();
const initialized = runJson(process.execPath, [cli, "init", "--project", target], target);
const execution = runJson(
  process.execPath,
  [
    cli,
    "run",
    "Implement increment in src/counter.js so node --test passes. Do not change tests.",
    "--verify",
    "node --test",
    "--model",
    "gpt-5.4-mini",
    "--reasoning",
    "low",
    "--project",
    target,
  ],
  target,
);
const recovered = runJson(process.execPath, [cli, "status", "--project", target], target);
const result = {
  apiVersion: "pkr.dev/v0.7",
  kind: "ThreeCommandDemoResult",
  projectRoot: target,
  elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
  initialized: initialized.projectId,
  outcome: execution.execution?.callback?.outcome ?? null,
  recoveredState: recovered.summary?.state ?? null,
  completedTasks: recovered.summary?.completedTasks ?? 0,
  stateDigest: recovered.stateDigest,
};
await writeFile(join(target, "demo-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.outcome !== "verified" || result.recoveredState !== "completed") {
  process.exitCode = 2;
}

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${executable} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function runJson(executable, args, cwd) {
  const result = run(executable, args, cwd);
  return JSON.parse(result.stdout);
}
