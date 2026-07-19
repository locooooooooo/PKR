import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { PkrStore } from "./store.js";
import type { JsonObject } from "./types.js";
import { writeJsonAtomic } from "./util.js";

export async function rebuildProjections(
  store: PkrStore,
  projectId: string,
  stateDir: string,
  projectionsPath: string,
): Promise<void> {
  const safeRoot = resolve(stateDir);
  const safeTarget = resolve(projectionsPath);
  if (!safeTarget.startsWith(`${safeRoot}\\`) && !safeTarget.startsWith(`${safeRoot}/`)) {
    throw new Error("projection path escapes the PKR state directory");
  }
  if (basename(safeTarget) !== "projections") {
    throw new Error("projection path must end in projections");
  }

  await rm(safeTarget, { recursive: true, force: true });
  await mkdir(safeTarget, { recursive: true });
  for (const record of store.listRecords(projectId)) {
    const target = join(safeTarget, "records", record.kind, `${record.id}.json`);
    await writeJsonAtomic(target, record.data);
  }

  const events = store.listEvents(projectId);
  const eventTarget = join(safeTarget, "events.jsonl");
  const temporary = `${eventTarget}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""),
    "utf8",
  );
  await rename(temporary, eventTarget);
  await writeJsonAtomic(join(safeTarget, "state.json"), store.exportState(projectId) as JsonObject);
}
