import { PkrError } from "./errors.js";
import type { PkrRuntime } from "./runtime.js";
import type { JsonObject } from "./types.js";
import { derivedId, sha256 } from "./util.js";

const MATERIAL_PATTERN =
  /\b(architecture|security|permission|public contract|compatibility|budget|deadline|release policy|credential|privacy)\b/i;

export interface StewardProposal extends JsonObject {
  kind: "StewardProposal";
  proposalId: string;
  request: string;
  outcome: string;
  objective: string;
  material: boolean;
  affectedKinds: string[];
  requiredApproval: string | null;
  state: "ready" | "awaitingApproval";
}

export class StewardService {
  constructor(private readonly runtime: PkrRuntime) {}

  prepare(request: string): StewardProposal {
    const normalized = request.trim();
    if (!normalized) {
      throw new PkrError("PKR-STEWARD-001", "Steward request cannot be empty");
    }
    const material = MATERIAL_PATTERN.test(normalized);
    const proposalId = `proposal_${sha256(normalized).slice(0, 32)}`;
    return {
      apiVersion: "pkr.dev/v0.6",
      kind: "StewardProposal",
      proposalId,
      request: normalized,
      outcome: normalized,
      objective: `Deliver the bounded outcome: ${normalized}`,
      material,
      affectedKinds: material
        ? ["Goal", "Task", "Decision", "Workflow"]
        : ["Goal", "Task"],
      requiredApproval: material ? this.runtime.ownerId() : null,
      state: material ? "awaitingApproval" : "ready",
      digest: `sha256:${sha256({ request: normalized, material })}`,
    };
  }

  async apply(
    proposal: StewardProposal,
    approvedBy?: string,
  ): Promise<JsonObject> {
    const ownerId = this.runtime.ownerId();
    if (proposal.material && approvedBy !== ownerId) {
      throw new PkrError(
        "PKR-STEWARD-002",
        `material proposal requires explicit approval by ${ownerId}`,
      );
    }
    const actorId = approvedBy ?? ownerId;
    let decisionId: string | null = null;
    if (proposal.material) {
      const decision = await this.runtime.createDecision(
        `Should the Project accept Steward proposal ${proposal.proposalId}?`,
        proposal.request,
        "The authenticated Project owner explicitly approved this material proposal.",
        proposal.affectedKinds,
        actorId,
        derivedId("command", `${proposal.proposalId}:decision`),
      );
      decisionId = ((decision.value as JsonObject).metadata as JsonObject).id as string;
    }
    const goal = await this.runtime.createGoal(
      proposal.outcome,
      actorId,
      derivedId("command", `${proposal.proposalId}:goal`),
    );
    const goalId = ((goal.value as JsonObject).metadata as JsonObject).id as string;
    const task = await this.runtime.createTask(
      goalId,
      proposal.objective,
      actorId,
      derivedId("command", `${proposal.proposalId}:task`),
    );
    const taskId = ((task.value as JsonObject).metadata as JsonObject).id as string;
    return {
      proposal,
      approvedBy: proposal.material ? actorId : null,
      decisionId,
      goalId,
      taskId,
      projectSequence: this.runtime.status().projectSequence as number,
    };
  }
}
