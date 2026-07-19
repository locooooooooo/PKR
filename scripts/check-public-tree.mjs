import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const forbiddenPaths = /(^|\/)(\.agents|\.pkr|iterations|node_modules|release)(\/|$)/;
const textExtensions = new Set([".json", ".md", ".mjs", ".ts", ".txt", ".yml", ".yaml"]);
const forbiddenContent = [
  /github_pat_[A-Za-z0-9_]+/,
  /ghp_[A-Za-z0-9]+/,
  /npm_[A-Za-z0-9]+/,
  /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/,
  /(?:E:|D:|C:)\\(?:Users|PKR|ProjectReview|同福客栈)/i,
];
const failures = [];
for (const path of files) {
  if (forbiddenPaths.test(path)) {
    failures.push(`forbidden public path: ${path}`);
    continue;
  }
  if (!textExtensions.has(extname(path)) && !["LICENSE", "NOTICE"].includes(path)) {
    continue;
  }
  const content = await readFile(join(root, path), "utf8");
  for (const pattern of forbiddenContent) {
    if (pattern.test(content)) {
      failures.push(`sensitive or machine-local content in ${path}: ${pattern}`);
    }
  }
}
if (failures.length) {
  console.error("FAIL: public tree boundary");
  failures.forEach((failure) => console.error(`  - ${failure}`));
  process.exitCode = 1;
} else {
  console.log(`PASS: public tree contains ${files.length} reviewed files.`);
}
