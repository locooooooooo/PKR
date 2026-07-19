import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const projectRoot = resolve(value("--project", process.cwd()));
const name = value("--name", basename(projectRoot));
const auditDirectory = resolve(value("--audit-dir", "soak/audits"));
const task = value("--task");
const verify = value("--verify", "npm test");
const cli = resolve(fileURLToPath(new URL("../dist/cli.js", import.meta.url)));
const command = task
  ? [process.execPath, [cli, "run", task, "--verify", verify, "--project", projectRoot]]
  : [process.execPath, [cli, "status", "--project", projectRoot]];
const result = spawnSync(command[0], command[1], {
  cwd: projectRoot,
  encoding: "utf8",
  env: process.env,
  windowsHide: true,
});
let payload;
try {
  payload = JSON.parse(result.stdout);
} catch {
  payload = { parseError: true };
}
const status = payload.status ?? payload;
const audit = {
  apiVersion: "pkr.dev/v0.7",
  kind: "PkrSoakObservation",
  observedAt: new Date().toISOString(),
  project: name,
  action: task ? "run" : "status",
  outcome: payload.execution?.callback?.outcome ?? status.summary?.state ?? "unknown",
  exitCode: result.status,
  independentVerification: payload.execution?.callback?.evidenceIds?.find((id) => id.includes("verification")) ?? null,
  stateDigest: status.stateDigest ?? null,
  summary: status.summary ?? null,
  blockers: payload.execution?.callback?.blockers ?? [],
  nextAction: payload.execution?.callback?.nextAction ?? null,
};
await mkdir(auditDirectory, { recursive: true });
const safeName = name.replace(/[^A-Za-z0-9._-]+/g, "-");
const output = resolve(auditDirectory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName}.json`);
await writeFile(output, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ audit, file: output }, null, 2)}\n`);
if (result.status !== 0) {
  process.exitCode = result.status ?? 2;
}
