import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scanner = join(root, "scripts", "check-sensitive-data.mjs");
const temporaryRoots = [];

afterEach(async () => {
  while (temporaryRoots.length) await rm(temporaryRoots.pop(), { recursive: true, force: true });
});

function runScanner(args) {
  return spawnSync(process.execPath, [scanner, ...args], { cwd: root, encoding: "utf8" });
}

function tarArchive(name, content) {
  const body = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.byteLength.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(32, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (body.byteLength % 512)) % 512);
  return gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024)]));
}

test("sensitive-data scanner covers plain logs without echoing the secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pkr-scan-"));
  temporaryRoots.push(directory);
  const clean = join(directory, "clean.log");
  const unsafe = join(directory, "unsafe.log");
  const credential = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
  await writeFile(clean, "bounded diagnostic output\n", "utf8");
  const bearer = `${["author", "ization"].join("")}: ${["bear", "er"].join("")}`;
  await writeFile(unsafe, `${bearer} ${credential}\n`, "utf8");

  const cleanResult = runScanner(["--path", clean]);
  assert.equal(cleanResult.status, 0, cleanResult.stderr || cleanResult.stdout);
  assert.equal(JSON.parse(cleanResult.stdout).passed, true);

  const unsafeResult = runScanner(["--path", unsafe]);
  assert.equal(unsafeResult.status, 1, unsafeResult.stderr || unsafeResult.stdout);
  assert.equal(JSON.parse(unsafeResult.stdout).findings[0].rule, "authorization-bearer");
  assert.equal(unsafeResult.stdout.includes(credential), false);
});

test("sensitive-data scanner inspects compressed npm-style tar entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pkr-tar-scan-"));
  temporaryRoots.push(directory);
  const tarball = join(directory, "package.tgz");
  const accessKey = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
  await writeFile(tarball, tarArchive("package/logs/runtime.log", `credential=${accessKey}\n`));

  const result = runScanner(["--tarball", tarball]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.findings.some((finding) => finding.path.includes("runtime.log")), true);
  assert.equal(result.stdout.includes(accessKey), false);
});
