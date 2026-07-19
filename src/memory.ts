import { PkrRuntime } from "./runtime.js";
import type { CommandResult, JsonObject, StoredRecord } from "./types.js";

export interface MemorySource {
  kind: string;
  id: string;
  revision: number;
}

export class MemoryService {
  constructor(private readonly runtime: PkrRuntime) {}

  derive(
    summary: string,
    sources: MemorySource[],
    visibility = "project",
    actorId = this.runtime.ownerId(),
    commandId?: string,
  ): Promise<CommandResult<JsonObject>> {
    return this.runtime.deriveMemory(summary, sources, visibility, actorId, commandId);
  }

  async retrieve(principalId: string, roleNames: string[] = []): Promise<StoredRecord[]> {
    await this.runtime.reconcileMemorySources();
    return this.runtime.listMemory(principalId, roleNames);
  }

  promote(
    memoryId: string,
    title: string,
    actorId = this.runtime.ownerId(),
    commandId?: string,
  ): Promise<CommandResult<JsonObject>> {
    return this.runtime.promoteMemory(memoryId, title, actorId, commandId);
  }
}
