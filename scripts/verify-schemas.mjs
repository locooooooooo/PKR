import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validators = [
  "conformance/validate_core_schema.py",
  "conformance/validate_bootstrap_schema.py",
  "conformance/validate_runtime_schema.py",
  "conformance/validate_coordination_schema.py",
  "conformance/validate_coordination_semantics.py",
];

function candidateInterpreters() {
  const candidates = [];
  if (process.env.PKR_PYTHON?.trim()) {
    candidates.push({ command: process.env.PKR_PYTHON.trim(), args: [] });
  }
  if (process.env.pythonLocation?.trim()) {
    candidates.push({
      command: join(
        process.env.pythonLocation.trim(),
        process.platform === "win32" ? "python.exe" : "bin/python",
      ),
      args: [],
    });
  }
  if (process.platform === "win32") {
    candidates.push({ command: "py", args: ["-3.11"] });
  }
  candidates.push(
    { command: "python3.11", args: [] },
    { command: "python3", args: [] },
    { command: "python", args: [] },
  );

  return candidates.filter(
    (candidate, index, all) =>
      all.findIndex(
        (item) =>
          item.command === candidate.command &&
          item.args.join("\0") === candidate.args.join("\0"),
      ) === index,
  );
}

function findPython311() {
  const rejected = [];
  for (const candidate of candidateInterpreters()) {
    const result = spawnSync(candidate.command, [...candidate.args, "--version"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    if (result.error?.code === "ENOENT") {
      continue;
    }
    const version = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (result.status === 0 && /\bPython 3\.11(?:\.|\b)/.test(version)) {
      return candidate;
    }
    rejected.push(`${candidate.command}: ${version || result.error?.message || "unavailable"}`);
  }

  console.error("FAIL: Python 3.11 is required for schema validation.");
  for (const message of rejected) {
    console.error(`  - ${message}`);
  }
  return undefined;
}

const python = findPython311();
if (!python) {
  process.exitCode = 1;
} else {
  console.log(`Using Python 3.11 via ${python.command}${python.args.length ? ` ${python.args.join(" ")}` : ""}.`);
  for (const validator of validators) {
    const result = spawnSync(
      python.command,
      [...python.args, "-B", join(root, validator)],
      {
        cwd: root,
        stdio: "inherit",
        shell: false,
        windowsHide: true,
      },
    );
    if (result.error) {
      console.error(`FAIL: could not run ${validator}: ${result.error.message}`);
      process.exitCode = 1;
      break;
    }
    if (result.status !== 0) {
      console.error(`FAIL: ${validator} exited with code ${result.status}.`);
      process.exitCode = result.status ?? 1;
      break;
    }
  }
}
