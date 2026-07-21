import type {
  EvolutionCandidateSpec,
  EvolutionObservationSpec,
} from "./evolution-model.js";
import { PkrRuntime } from "./runtime.js";
import type { CommandResult, JsonObject } from "./types.js";

export class EvolutionService {
  constructor(private readonly runtime: PkrRuntime) {}

  observeRepeatedFailures(
    candidate: EvolutionCandidateSpec,
    proposerId: string,
    threshold = 2,
    commandId?: string,
  ): Promise<CommandResult<JsonObject>> {
    return this.runtime.proposeEvolutionFromFailures(
      candidate,
      proposerId,
      threshold,
      commandId,
    );
  }

  observe(
    candidate: EvolutionCandidateSpec,
    observation: EvolutionObservationSpec,
    proposerId: string,
    commandId?: string,
  ): Promise<CommandResult<JsonObject>> {
    return this.runtime.proposeEvolutionFromObservation(
      candidate,
      observation,
      proposerId,
      commandId,
    );
  }

  revise(
    candidateId: string,
    candidate: EvolutionCandidateSpec,
    proposerId: string,
    commandId?: string,
  ): Promise<CommandResult<JsonObject>> {
    return this.runtime.reviseEvolutionCandidate(
      candidateId,
      candidate,
      proposerId,
      commandId,
    );
  }

  approve(
    candidateId: string,
    approverId = this.runtime.ownerId(),
    commandId?: string,
  ): Promise<CommandResult<JsonObject>> {
    return this.runtime.approveEvolutionCandidate(candidateId, approverId, commandId);
  }

  evaluate(
    candidateId: string,
    verifierId: string,
    commandId?: string,
  ): Promise<CommandResult<JsonObject>> {
    return this.runtime.evaluateEvolutionCandidate(candidateId, verifierId, commandId);
  }

  evaluateExternally(
    candidateId: string,
    supervisorId: string,
    result: JsonObject,
    commandId?: string,
  ): Promise<CommandResult<JsonObject>> {
    return this.runtime.recordExternalEvolutionEvaluation(
      candidateId,
      supervisorId,
      result,
      commandId,
    );
  }

  promote(
    candidateId: string,
    promoterId = this.runtime.ownerId(),
    externalSupervisorId?: string,
    commandId?: string,
  ): Promise<CommandResult<JsonObject>> {
    return this.runtime.promoteEvolutionCandidate(
      candidateId,
      promoterId,
      externalSupervisorId,
      commandId,
    );
  }

  monitor(
    candidateId: string,
    observerId: string,
    value: string | number | boolean,
    commandId?: string,
  ): Promise<CommandResult<JsonObject>> {
    return this.runtime.monitorEvolutionCandidate(
      candidateId,
      observerId,
      value,
      commandId,
    );
  }

  status(candidateId: string): JsonObject {
    return this.runtime.evolutionCandidateStatus(candidateId);
  }
}
