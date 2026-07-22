import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseIntegerOption(args, name, fallback, minimum, maximum) {
  const index = args.indexOf(name);
  const value = index < 0 ? fallback : Number(args[index + 1]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

export async function temporaryGitProject(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const init = spawnSync("git", ["init", "-b", "main"], { cwd: root, encoding: "utf8" });
  if (init.status !== 0) throw new Error(init.stderr || "git init failed");
  await writeFile(join(root, ".gitignore"), ".pkr/\n", "utf8");
  await writeFile(join(root, "README.md"), "# PKR performance fixture\n", "utf8");
  const add = spawnSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
  if (add.status !== 0) throw new Error(add.stderr || "git add failed");
  const commit = spawnSync(
    "git",
    ["-c", "user.name=PKR Benchmark", "-c", "user.email=pkr@example.invalid", "commit", "-m", "fixture"],
    { cwd: root, encoding: "utf8" },
  );
  if (commit.status !== 0) throw new Error(commit.stderr || "git commit failed");
  return root;
}

export async function measured(operation) {
  const started = process.hrtime.bigint();
  const value = await operation();
  return { durationMs: Number(process.hrtime.bigint() - started) / 1_000_000, value };
}

export function statistics(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    samplesMs: samples.map((sample) => Number(sample.toFixed(3))),
    minMs: Number(sorted[0].toFixed(3)),
    medianMs: Number(percentile(0.5).toFixed(3)),
    p95Ms: Number(percentile(0.95).toFixed(3)),
    maxMs: Number(sorted.at(-1).toFixed(3)),
    meanMs: Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(3)),
  };
}

export function referenceEnvironment() {
  const processors = cpus();
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8" });
  const packageJson = JSON.parse(spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(require('./package.json')))"] , {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).stdout);
  return {
    node: process.version,
    platform: platform(),
    release: release(),
    arch: process.arch,
    cpuModel: processors[0]?.model ?? "unknown",
    logicalCpuCount: processors.length,
    totalMemoryBytes: totalmem(),
    processRssBytes: process.memoryUsage().rss,
    packageVersion: packageJson.version,
    commit: git.status === 0 ? git.stdout.trim() : "unknown",
    worktreeDirty: status.status === 0 ? status.stdout.length > 0 : null,
  };
}

export async function emitReport(report, outputPath) {
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    const target = resolve(outputPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, encoded, "utf8");
  }
  process.stdout.write(encoded);
}

export async function replaceStateFromSnapshot(root, snapshot) {
  const state = join(root, ".pkr");
  await rm(state, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  await cp(snapshot, state, { recursive: true, force: false, errorOnExist: true });
}

export async function readProjectionDigest(root) {
  const state = JSON.parse(await readFile(join(root, ".pkr", "projections", "state.json"), "utf8"));
  return state.digest;
}
