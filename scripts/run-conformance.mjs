import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const validators = [
  "validate_core_schema.py",
  "validate_bootstrap_schema.py",
  "validate_runtime_schema.py",
  "validate_coordination_schema.py",
  "validate_coordination_semantics.py",
];

const candidates = process.platform === "win32"
  ? [
      { executable: "py", prefix: ["-3.11"] },
      { executable: "python", prefix: [] },
      { executable: "python3", prefix: [] },
    ]
  : [
      { executable: "python3", prefix: [] },
      { executable: "python", prefix: [] },
    ];

const python = candidates.find((candidate) => {
  const result = spawnSync(candidate.executable, [...candidate.prefix, "--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    return false;
  }
  const version = `${result.stdout}\n${result.stderr}`.match(/Python\s+(\d+)\.(\d+)/);
  return !!version && (Number(version[1]) > 3 ||
    (Number(version[1]) === 3 && Number(version[2]) >= 11));
});

if (!python) {
  console.error("PKR conformance requires Python 3.11 or newer.");
  process.exit(127);
}

for (const validator of validators) {
  const script = join(root, "conformance", validator);
  const result = spawnSync(python.executable, [...python.prefix, "-B", script], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
