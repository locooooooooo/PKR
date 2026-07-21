import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { publicTree, readJson, root, run, runNpm } from "./release-utils.mjs";

const packageJson = readJson("package.json");
const temp = mkdtempSync(join(tmpdir(), "pkr-candidate-"));
const source = join(temp, "source");
const consumer = join(temp, "consumer");
mkdirSync(source);
mkdirSync(consumer);

try {
  const { publicFiles } = publicTree();
  for (const path of publicFiles) {
    const target = join(source, path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    cpSync(join(root, path), target);
  }

  runNpm(["ci", "--ignore-scripts"], { cwd: source });
  runNpm(["run", "build"], { cwd: source });
  const sourceHelp = run(process.execPath, ["dist/cli.js", "--help"], { cwd: source }).stdout;

  const packed = JSON.parse(runNpm(["pack", "--json", "--ignore-scripts"], { cwd: source }).stdout)[0];
  const tarball = join(source, packed.filename);
  runNpm(["init", "--yes"], { cwd: consumer });
  runNpm(["install", "--ignore-scripts", tarball], { cwd: consumer });
  const installedPackage = join(consumer, "node_modules", ...packageJson.name.split("/"));
  const installed = JSON.parse(readFileSync(join(installedPackage, "package.json"), "utf8"));
  const installedHelp = run(process.execPath, [join(installedPackage, "dist", "cli.js"), "--help"], { cwd: consumer }).stdout;

  if (installed.version !== packageJson.version || sourceHelp !== installedHelp) {
    throw new Error("source and installed tarball CLI/version disagree");
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    package: packageJson.name,
    version: installed.version,
    tarball: basename(tarball),
    sourceCliMatchesTarball: true,
    publicSourceFilesCopied: publicFiles.length,
    publishAttempted: false,
  }, null, 2)}\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
