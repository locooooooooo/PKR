import { PkrError } from "./errors.js";
import { STARTER_PROFILES, type StarterProfileName } from "./profiles.js";
import { PkrRuntime } from "./runtime.js";
import type { CommandResult, JsonObject } from "./types.js";

export class PackageService {
  constructor(private readonly runtime: PkrRuntime) {}

  installStarterProfile(
    name: StarterProfileName,
    decisionId: string,
    approvedCapabilities: string[],
    actorId = this.runtime.ownerId(),
    commandId?: string,
    failStaging = false,
  ): Promise<CommandResult<JsonObject>> {
    const profile = STARTER_PROFILES[name];
    if (!profile) {
      throw new PkrError("PKR-PACKAGE-001", `unknown starter profile ${name}`);
    }
    return this.runtime.installProfilePackage(
      profile,
      decisionId,
      approvedCapabilities,
      actorId,
      commandId,
      failStaging,
    );
  }

  uninstall(
    packageId: string,
    actorId = this.runtime.ownerId(),
    commandId?: string,
  ): Promise<CommandResult<JsonObject>> {
    return this.runtime.uninstallPackage(packageId, actorId, commandId);
  }

  rollback(
    packageId: string,
    targetInstallationId: string,
    actorId = this.runtime.ownerId(),
    commandId?: string,
  ): Promise<CommandResult<JsonObject>> {
    return this.runtime.rollbackPackage(
      packageId,
      targetInstallationId,
      actorId,
      commandId,
    );
  }
}
