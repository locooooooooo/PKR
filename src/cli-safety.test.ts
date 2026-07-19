import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(repositoryRoot, "dist", "cli.js");
const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function invoke(projectRoot: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args, "--project", projectRoot], {
    encoding: "utf8",
  });
}

test("help is side-effect free and unknown options fail before Runtime open", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pkr-cli-safety-"));
  temporaryRoots.push(projectRoot);
  const rootHelp = invoke(projectRoot, ["--help"]);
  assert.equal(rootHelp.status, 0);
  assert.match(rootHelp.stdout, /Usage:/);
  assert.equal(rootHelp.stderr, "");
  assert.equal(existsSync(join(projectRoot, ".pkr")), false);

  const initHelp = invoke(projectRoot, ["init", "--help"]);
  assert.equal(initHelp.status, 0);
  assert.match(initHelp.stdout, /pkr init/);
  assert.equal(existsSync(join(projectRoot, ".pkr")), false);

  const unknownOption = invoke(projectRoot, ["init", "--definitely-unknown"]);
  assert.equal(unknownOption.status, 1);
  assert.match(unknownOption.stderr, /unknown option/);
  assert.equal(existsSync(join(projectRoot, ".pkr")), false);

  const unknownCommand = invoke(projectRoot, ["not-a-command"]);
  assert.equal(unknownCommand.status, 1);
  assert.match(unknownCommand.stderr, /unknown command/);
  assert.equal(existsSync(join(projectRoot, ".pkr")), false);
});
