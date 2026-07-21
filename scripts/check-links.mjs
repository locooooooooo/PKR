import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { assert, publicTree, root } from "./release-utils.mjs";

const markdown = publicTree().publicFiles.filter((path) => extname(path).toLowerCase() === ".md");
const failures = [];
let checked = 0;

for (const path of markdown) {
  const text = readFileSync(resolve(root, path), "utf8");
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    target = target.split(/\s+["']/)[0];
    if (/^(?:https?:|mailto:)/i.test(target) || target.startsWith("#")) {
      continue;
    }
    const filePart = decodeURIComponent(target.split("#")[0].split("?")[0]);
    if (!filePart) {
      continue;
    }
    checked += 1;
    const absolute = resolve(root, dirname(path), filePart);
    if (!existsSync(absolute)) {
      failures.push(`${path}: missing ${target}`);
    }
  }
}

assert(failures.length === 0, `local Markdown link check failed:\n${failures.join("\n")}`);
process.stdout.write(`${JSON.stringify({ ok: true, markdownFiles: markdown.length, localLinksChecked: checked }, null, 2)}\n`);
