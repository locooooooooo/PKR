import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { PkrError } from "./errors.js";
import { EvolutionService } from "./evolution.js";
import type {
  EvolutionCandidateSpec,
  GovernancePolicyContent,
  ManagedAdapterContent,
  PolicyCanaryScenario,
} from "./evolution-model.js";
import { STARTER_PROFILES, type ProfilePackage } from "./profiles.js";
import { PkrRuntime } from "./runtime.js";
import type { JsonObject } from "./types.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];

function objectId(value: JsonObject): string {
  return (value.metadata as JsonObject).id as string;
}

function runCli(projectRoot: string, args: string[]): JsonObject {
  const result = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, "dist", "cli.js"), ...args, "--project", projectRoot],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as JsonObject;
}

function monitoringPlan(): EvolutionCandidateSpec["monitoring"] {
  return {
    measure: "post-promotion success",
    window: "P1D",
    maxObservations: 2,
    threshold: { operator: "eq", value: true, severity: "error" },
    onBreach: "require-rollback",
  };
}

function workflowCandidate(options: {
  version?: string;
  expectedFinalState?: string;
  expectedImprovement?: string;
} = {}): EvolutionCandidateSpec {
  const profile: ProfilePackage = {
    ...STARTER_PROFILES.web,
    version: options.version ?? "0.8.0",
    title: `PKR Web Project Profile ${options.version ?? "0.8.0"}`,
    workflow: JSON.parse(JSON.stringify(STARTER_PROFILES.web.workflow)) as ProfilePackage["workflow"],
  };
  return {
    targetKind: "workflow",
    targetId: profile.packageId,
    activeVersion: STARTER_PROFILES.web.version,
    expectedImprovement: options.expectedImprovement ?? "Require replayable release evidence.",
    nonGoals: ["No authority or capability expansion."],
    permissionDelta: { add: [], remove: [] },
    monitoring: monitoringPlan(),
    profile,
    canary: {
      maxScenarios: 2,
      maxTransitions: 8,
      requiredSuccessRate: 1,
      baselineSuccessRate: 1,
      maxRegression: 0,
      protectedOutputScope: [".pkr/canary"],
      scenarios: [{
        name: "approved-release",
        steps: [
          { to: "implement", context: { approved: true } },
          { to: "test", context: { implementation: "complete" } },
          { to: "preview", context: { tests: "passed" } },
          { to: "released", context: { preview: "accepted" } },
        ],
        expectedFinalState: options.expectedFinalState ?? "released",
      }],
    },
  };
}

function runtimeCandidate(): EvolutionCandidateSpec {
  return {
    targetKind: "runtime",
    targetId: "dev.pkr.reference-runtime",
    activeVersion: "0.7.0",
    runtimeVersion: "0.8.1",
    expectedImprovement: "Harden recovery without replacing the in-process policy evaluator.",
    nonGoals: ["No in-process binary replacement."],
    permissionDelta: { add: [], remove: [] },
    monitoring: monitoringPlan(),
    canary: {
      maxScenarios: 2,
      maxTransitions: 4,
      requiredSuccessRate: 1,
      baselineSuccessRate: 1,
      maxRegression: 0,
      protectedOutputScope: ["runtime-binary", "runtime-state"],
      scenarios: [{
        name: "restart-recovery",
        steps: [{ to: "verified", context: { restart: "recovered" } }],
        expectedFinalState: "verified",
      }],
    },
  };
}

function promptCandidate(
  activePromptId: string,
  activeVersion: string,
  options: {
    version?: string;
    template?: string;
    requiredIncludes?: string[];
    forbiddenIncludes?: string[];
    maxRenderedCharacters?: number;
  } = {},
): EvolutionCandidateSpec {
  return {
    targetKind: "prompt",
    targetId: activePromptId,
    activeVersion,
    expectedImprovement: "Make blocked Agent outcomes explicit and recoverable.",
    nonGoals: ["No model call, permission expansion, or production mutation during evaluation."],
    permissionDelta: { add: [], remove: [] },
    monitoring: monitoringPlan(),
    prompt: {
      version: options.version ?? "1.1.0",
      title: "Governed Agent execution prompt",
      template: options.template ??
        "Project {{project.name}}. If work is blocked, emit BLOCKER_REASON and NEXT_SAFE_ACTION.",
      variables: ["project.name"],
    },
    canary: {
      maxScenarios: 2,
      maxRenderedCharacters: options.maxRenderedCharacters ?? 500,
      requiredSuccessRate: 1,
      baselineSuccessRate: 1,
      maxRegression: 0,
      protectedOutputScope: ["prompt-render"],
      scenarios: [{
        name: "blocked-task-contract",
        input: { project: { name: "PKR" } },
        requiredIncludes: options.requiredIncludes ?? ["Project PKR", "BLOCKER_REASON", "NEXT_SAFE_ACTION"],
        forbiddenIncludes: options.forbiddenIncludes ?? ["SECRET"],
      }],
    },
  };
}

function governancePolicy(
  version = "1.0.0",
  title = "PKR governance baseline",
): GovernancePolicyContent {
  return {
    version,
    title,
    rule: "Governed changes require owner approval, immutable audit, Verification, and rollback.",
    scopeKinds: [
      "Decision",
      "Constraint",
      "Workflow",
      "Verification",
      "Artifact",
      "Role",
      "Release",
    ],
    severity: "critical",
    enforcement: "blocking",
    protections: {
      ownerApprovalRequired: true,
      auditRetention: "immutable",
      verificationRequired: true,
      rollbackRequired: true,
    },
    defaultEffect: "deny",
    rules: [
      {
        id: "allow-governed-promotion",
        action: "pkr/promote",
        effect: "allow",
        when: {
          op: "and",
          expressions: [
            { op: "eq", path: "ownerApproved", value: true },
            { op: "eq", path: "verificationPassed", value: true },
            { op: "eq", path: "auditRetained", value: true },
          ],
        },
      },
      {
        id: "allow-owner-permission-change",
        action: "pkr/permission-change",
        effect: "allow",
        when: { op: "eq", path: "ownerApproved", value: true },
      },
      {
        id: "allow-requested-rollback",
        action: "pkr/rollback",
        effect: "allow",
        when: { op: "eq", path: "requested", value: true },
      },
      {
        id: "allow-owner-release",
        action: "pkr/release",
        effect: "allow",
        when: { op: "eq", path: "ownerApproved", value: true },
      },
    ],
  };
}

function policyCandidate(
  activePolicyId: string,
  activeContentDigest: string,
  options: {
    policy?: GovernancePolicyContent;
    maxRulesEvaluated?: number;
    scenarios?: PolicyCanaryScenario[];
  } = {},
): EvolutionCandidateSpec {
  return {
    targetKind: "policy",
    targetId: activePolicyId,
    activeVersion: activeContentDigest,
    expectedImprovement: "Make release authorization explicit without weakening governance.",
    nonGoals: ["No permission expansion or bypass of protected governance invariants."],
    permissionDelta: { add: [], remove: [] },
    monitoring: monitoringPlan(),
    policy: options.policy ?? governancePolicy("1.1.0", "PKR governed release policy"),
    canary: {
      maxScenarios: 4,
      maxRulesEvaluated: options.maxRulesEvaluated ?? 20,
      requiredSuccessRate: 1,
      baselineSuccessRate: 1,
      maxRegression: 0,
      protectedOutputScope: ["policy-decision"],
      scenarios: options.scenarios ?? [
        {
          name: "governed-promotion",
          action: "pkr/promote",
          context: {
            ownerApproved: true,
            verificationPassed: true,
            auditRetained: true,
          },
          expectedEffect: "allow",
        },
        {
          name: "unapproved-promotion",
          action: "pkr/promote",
          context: {
            ownerApproved: false,
            verificationPassed: true,
            auditRetained: true,
          },
          expectedEffect: "deny",
        },
        {
          name: "requested-rollback",
          action: "pkr/rollback",
          context: { requested: true },
          expectedEffect: "allow",
        },
      ],
    },
  };
}

function managedAdapter(
  version = "0.6.0",
  implementationMarker = "1",
  capabilities = ["filesystem.read", "filesystem.write", "terminal"],
): ManagedAdapterContent {
  return {
    adapterId: "pkr.adapter.local-process",
    version,
    title: `PKR local process Adapter ${version}`,
    implementationDigest: `sha256:${implementationMarker.repeat(64)}`,
    protocolVersion: "pkr.dev/v0.4",
    executionMode: "isolated-process",
    authority: "non-authoritative",
    capabilities,
    isolation: {
      filesystem: "scoped",
      network: "none",
      credentials: "references-only",
    },
  };
}

function adapterCandidate(
  activeAdapterVersionId: string,
  activeContentDigest: string,
  options: {
    adapter?: ManagedAdapterContent;
    permissionRemove?: string[];
    maxPayloadBytes?: number;
  } = {},
): EvolutionCandidateSpec {
  return {
    targetKind: "adapter",
    targetId: activeAdapterVersionId,
    activeVersion: activeContentDigest,
    expectedImprovement: "Harden callback validation without changing provider authority.",
    nonGoals: ["No binary hot swap, network access, credential access, or authority expansion."],
    permissionDelta: { add: [], remove: options.permissionRemove ?? [] },
    monitoring: monitoringPlan(),
    adapter: options.adapter ?? managedAdapter("0.7.0", "2"),
    canary: {
      maxScenarios: 3,
      maxPayloadBytes: options.maxPayloadBytes ?? 5000,
      requiredSuccessRate: 1,
      baselineSuccessRate: 1,
      maxRegression: 0,
      protectedOutputScope: ["provider-callback", "capability-statement"],
      scenarios: [
        {
          name: "verified-callback",
          requiredCapabilities: ["filesystem.read", "filesystem.write", "terminal"],
          callback: {
            outcome: "verified",
            completed: ["bounded-task"],
            incomplete: [],
            blockers: [],
            evidenceIds: ["artifact_adapter_canary"],
            outputs: [{ kind: "artifact", locator: "pkr://adapter-canary/artifact" }],
            nextAction: "Submit for independent Verification.",
          },
          expectedAccepted: true,
        },
        {
          name: "verified-without-evidence",
          requiredCapabilities: ["filesystem.read"],
          callback: {
            outcome: "verified",
            completed: ["bounded-task"],
            incomplete: [],
            blockers: [],
            evidenceIds: [],
            outputs: [{ kind: "result", locator: "pkr://adapter-canary/rejected" }],
            nextAction: "Do not accept this callback.",
          },
          expectedAccepted: false,
        },
      ],
    },
  };
}

async function evolutionProject(name: string): Promise<{
  root: string;
  runtime: PkrRuntime;
  evolution: EvolutionService;
  baseInstallationId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `pkr-v08-${name}-`));
  temporaryRoots.push(root);
  const runtime = await PkrRuntime.init(root, repositoryRoot, {
    name,
    title: name,
    outcome: `Prove PKR v0.8 ${name}.`,
  });
  const installDecision = await runtime.createDecision(
    "Install the governed evolution baseline?",
    "Install the web Profile",
    "The v0.8 canary requires one rollback target.",
    ["Workflow", "Decision"],
    runtime.ownerId(),
  );
  const installed = await runtime.installProfilePackage(
    STARTER_PROFILES.web,
    objectId(installDecision.value as JsonObject),
    STARTER_PROFILES.web.requestedCapabilities,
  );
  const goal = await runtime.createGoal("Collect repeated governed execution failures");
  const goalId = objectId(goal.value as JsonObject);
  const agent = await runtime.registerAgent("failure-observer", "local-process");
  const agentId = objectId(agent.value as JsonObject);
  for (let index = 0; index < 2; index += 1) {
    const task = await runtime.createTask(goalId, `Observe bounded failure ${index + 1}`);
    const dispatch = await runtime.dispatch(objectId(task.value as JsonObject), agentId);
    await runtime.expireLease((dispatch.value as JsonObject).leaseId as string);
  }
  return {
    root,
    runtime,
    evolution: new EvolutionService(runtime),
    baseInstallationId: (installed.value as JsonObject).installationId as string,
  };
}

afterEach(async () => {
  while (temporaryRoots.length) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

test("independent evaluation, approval, promotion, monitoring breach, and rollback retain history", async () => {
  const { root, runtime, evolution, baseInstallationId } = await evolutionProject("promotion");
  const proposal = await evolution.observeRepeatedFailures(
    workflowCandidate(),
    "agent_proposer_001",
    2,
    "command_evolution_success_propose",
  );
  const candidateId = (proposal.value as JsonObject).candidateId as string;
  assert.equal((proposal.value as JsonObject).state, "inactive");
  assert.equal(runtime.getRecord("PackageInstallation", baseInstallationId).data.state, "active");
  assert.equal(evolution.status(candidateId).state, "proposed");
  assert.equal(runtime.listRecords("Issue").length, 1);

  await assert.rejects(
    evolution.approve(candidateId, "agent_proposer_001"),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-002",
  );
  await assert.rejects(
    evolution.approve(candidateId, runtime.ownerId()),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-005",
  );
  const evaluated = await evolution.evaluate(
    candidateId,
    "agent_verifier_001",
    "command_evolution_success_evaluate",
  );
  assert.equal((evaluated.value as JsonObject).passed, true);
  await assert.rejects(
    evolution.approve(candidateId, "agent_verifier_001"),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-002",
  );
  await evolution.approve(candidateId, runtime.ownerId(), "command_evolution_success_approve");

  const promoted = await evolution.promote(
    candidateId,
    runtime.ownerId(),
    undefined,
    "command_evolution_success_promote",
  );
  const candidateInstallationId = (promoted.value as JsonObject).installationId as string;
  assert.equal(evolution.status(candidateId).state, "active");
  assert.equal(runtime.getRecord("PackageInstallation", baseInstallationId).data.state, "superseded");
  const breached = await evolution.monitor(
    candidateId,
    "agent_monitor_001",
    false,
    "command_evolution_monitor_breach",
  );
  assert.equal((breached.value as JsonObject).state, "breached");
  assert.equal((breached.value as JsonObject).rollbackRequired, true);
  assert.equal(evolution.status(candidateId).monitoringState, "breached");
  assert.equal(evolution.status(candidateId).rollbackRequired, true);
  await assert.rejects(
    evolution.monitor(candidateId, "agent_monitor_002", true),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-014",
  );

  const evidenceIds = runtime.listRecords("Verification").map((record) => record.id);
  const decisionIds = runtime.listRecords("Decision").map((record) => record.id);
  const monitoringIds = evolution.status(candidateId).monitoringIds as string[];
  await runtime.rollbackPackage(
    STARTER_PROFILES.web.packageId,
    baseInstallationId,
    runtime.ownerId(),
    "command_evolution_success_rollback",
  );
  assert.equal(runtime.getRecord("PackageInstallation", candidateInstallationId).data.state, "superseded");
  assert.equal(runtime.getRecord("PackageInstallation", baseInstallationId).data.state, "active");
  assert.equal(evolution.status(candidateId).state, "rolledBack");
  assert.equal(evolution.status(candidateId).rollbackRequired, false);
  assert.deepEqual(runtime.listRecords("Verification").map((record) => record.id), evidenceIds);
  assert.deepEqual(runtime.listRecords("Decision").map((record) => record.id), decisionIds);
  assert.deepEqual(evolution.status(candidateId).monitoringIds, monitoringIds);
  assert.equal(
    runtime.listEvents().some((event) => event.type === "pkr.package.rolledBack"),
    true,
  );
  assert.equal(
    runtime.listEvents().some((event) => event.type === "pkr.evolution.monitoringBreached"),
    true,
  );
  runtime.close();

  assert.equal(runCli(root, ["evolution", "status", "--id", candidateId]).state, "rolledBack");
});

test("candidate revision supersedes prior evidence and a failed canary preserves the active version", async () => {
  const { runtime, evolution, baseInstallationId } = await evolutionProject("rejection");
  const proposal = await evolution.observeRepeatedFailures(
    workflowCandidate(),
    "agent_proposer_002",
    2,
    "command_evolution_revision_propose",
  );
  const originalId = (proposal.value as JsonObject).candidateId as string;
  const originalEvaluation = await evolution.evaluate(
    originalId,
    "agent_verifier_002",
    "command_evolution_revision_evaluate",
  );
  assert.equal((originalEvaluation.value as JsonObject).passed, true);

  const revised = await evolution.revise(
    originalId,
    workflowCandidate({
      version: "0.8.1",
      expectedFinalState: "preview",
      expectedImprovement: "Test a deliberately rejected regression candidate.",
    }),
    "agent_proposer_002",
    "command_evolution_revision_create",
  );
  const revisedId = (revised.value as JsonObject).candidateId as string;
  assert.equal(evolution.status(originalId).state, "superseded");
  assert.equal(evolution.status(revisedId).verificationIds instanceof Array, true);
  assert.equal((evolution.status(revisedId).verificationIds as unknown[]).length, 0);
  await assert.rejects(
    evolution.promote(originalId, runtime.ownerId()),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-003",
  );

  const failed = await evolution.evaluate(
    revisedId,
    "agent_verifier_003",
    "command_evolution_revised_evaluate",
  );
  assert.equal((failed.value as JsonObject).passed, false);
  await assert.rejects(
    evolution.approve(revisedId, runtime.ownerId()),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-005",
  );
  assert.equal(evolution.status(revisedId).state, "rejected");
  await assert.rejects(
    evolution.promote(revisedId, runtime.ownerId()),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-005",
  );
  assert.equal(runtime.getRecord("PackageInstallation", baseInstallationId).data.state, "active");
  assert.equal(runtime.listRecords("Verification").length, 2);
  runtime.close();
});

test("Runtime candidates require digest-bound external supervision and never self-activate in process", async () => {
  const { runtime, evolution } = await evolutionProject("runtime-supervisor");
  const proposal = await evolution.observeRepeatedFailures(
    runtimeCandidate(),
    "agent_runtime_proposer",
    2,
    "command_runtime_candidate_propose",
  );
  const candidateId = (proposal.value as JsonObject).candidateId as string;
  const candidateDigest = (proposal.value as JsonObject).contentDigest as string;
  await assert.rejects(
    evolution.evaluate(candidateId, "agent_runtime_verifier"),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-005",
  );
  const supervisorId = "supervisor_runtime_001";
  const supervisorResult: JsonObject = {
    adapter: "pkr.external-supervisor/v1",
    supervisorId,
    candidateDigest,
    runtimeVersion: "0.8.1",
    passed: true,
    reason: "Restart recovery and rollback both passed outside the Runtime process.",
    rollbackTested: true,
    atomicSwitchReady: true,
    scenarioCount: 1,
    transitionCount: 1,
    successRate: 1,
    regression: 0,
    protectedOutputScope: ["runtime-state", "runtime-binary"],
  };
  await assert.rejects(
    evolution.evaluateExternally(
      candidateId,
      supervisorId,
      { ...supervisorResult, candidateDigest: "sha256:wrong" },
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-004",
  );
  const external = await evolution.evaluateExternally(
    candidateId,
    supervisorId,
    supervisorResult,
    "command_runtime_candidate_evaluate",
  );
  assert.equal((external.value as JsonObject).passed, true);
  assert.equal(evolution.status(candidateId).state, "verified");
  await evolution.approve(candidateId, runtime.ownerId(), "command_runtime_candidate_approve");
  await assert.rejects(
    evolution.monitor(candidateId, "agent_runtime_monitor", true),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-006",
  );
  await assert.rejects(
    evolution.promote(candidateId, runtime.ownerId()),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-006",
  );
  await assert.rejects(
    evolution.promote(candidateId, runtime.ownerId(), supervisorId),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-006",
  );
  assert.equal(
    runtime.listEvents().some((event) => event.type === "pkr.evolution.externalEvaluationRecorded"),
    true,
  );
  runtime.close();
});

test("assurance debt, breached Metrics, and attributed human feedback normalize into inactive candidates", async () => {
  const { root, runtime, evolution, baseInstallationId } = await evolutionProject("observation-sources");
  const failedProposal = await evolution.observeRepeatedFailures(
    workflowCandidate({
      version: "0.8.2",
      expectedFinalState: "preview",
      expectedImprovement: "Create real failed Verification evidence.",
    }),
    "agent_failure_proposer",
    2,
    "command_observation_failed_propose",
  );
  const failedCandidateId = (failedProposal.value as JsonObject).candidateId as string;
  const failedEvaluation = await evolution.evaluate(
    failedCandidateId,
    "agent_failure_verifier",
    "command_observation_failed_evaluate",
  );
  assert.equal((failedEvaluation.value as JsonObject).passed, false);
  const failedVerificationId = (failedEvaluation.value as JsonObject).verificationId as string;
  const failedVerification = runtime.getRecord("Verification", failedVerificationId);

  const assuranceProposal = await evolution.observe(
    workflowCandidate({ version: "0.8.3", expectedImprovement: "Reduce canary assurance debt." }),
    {
      rule: "assurance-debt",
      threshold: 1,
      verificationRefs: [{ id: failedVerificationId, revision: failedVerification.revision }],
    },
    "agent_assurance_proposer",
    "command_assurance_debt_propose",
  );
  const assuranceIssue = runtime.getRecord(
    "Issue",
    (assuranceProposal.value as JsonObject).issueId as string,
  );
  assert.equal(
    (assuranceIssue.data.extensions as JsonObject)["pkr.evolution/observation-rule"],
    "assurance-debt",
  );
  const assuranceCandidateId = (assuranceProposal.value as JsonObject).candidateId as string;
  const passingEvaluation = await evolution.evaluate(
    assuranceCandidateId,
    "agent_assurance_verifier",
    "command_assurance_debt_evaluate",
  );
  await evolution.approve(
    assuranceCandidateId,
    runtime.ownerId(),
    "command_assurance_debt_approve",
  );
  const passingVerificationId = (passingEvaluation.value as JsonObject).verificationId as string;
  const passingVerification = runtime.getRecord("Verification", passingVerificationId);
  const beforeNonDebtReference = runtime.stateDigest();
  await assert.rejects(
    evolution.observe(
      workflowCandidate({ version: "0.8.30" }),
      {
        rule: "assurance-debt",
        verificationRefs: [{ id: passingVerificationId, revision: passingVerification.revision }],
      },
      "agent_assurance_proposer",
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-007",
  );
  assert.equal(runtime.stateDigest(), beforeNonDebtReference);
  const beforeStaleReference = runtime.stateDigest();
  await assert.rejects(
    evolution.observe(
      workflowCandidate({ version: "0.8.31" }),
      {
        rule: "assurance-debt",
        verificationRefs: [{ id: failedVerificationId, revision: failedVerification.revision + 1 }],
      },
      "agent_assurance_proposer",
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-007",
  );
  assert.equal(runtime.stateDigest(), beforeStaleReference);

  const beforeInvalidMetric = runtime.stateDigest();
  await assert.rejects(
    runtime.recordMetric(
      "Invalid ordered string comparison",
      "pkr/runtime-tests",
      "P1D",
      { operator: "gt", value: "slow", severity: "warning" },
      "fast",
      runtime.ownerId(),
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-METRIC-001",
  );
  assert.equal(runtime.stateDigest(), beforeInvalidMetric);

  const healthyMetric = await runtime.recordMetric(
    "Canary failure rate",
    "pkr/runtime-tests",
    "P7D",
    { operator: "lte", value: 0.1, severity: "error" },
    0.05,
    runtime.ownerId(),
    "command_metric_healthy",
  );
  const healthyMetricId = objectId(healthyMetric.value as JsonObject);
  assert.equal((healthyMetric.value as JsonObject).status instanceof Object, true);
  assert.equal(((healthyMetric.value as JsonObject).status as JsonObject).phase, "healthy");
  const beforeHealthyObservation = runtime.stateDigest();
  await assert.rejects(
    evolution.observe(
      workflowCandidate({ version: "0.8.4" }),
      { rule: "metric-threshold", metric: { id: healthyMetricId, revision: 1 } },
      "agent_metric_proposer",
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-007",
  );
  assert.equal(runtime.stateDigest(), beforeHealthyObservation);

  const breachedMetric = await runtime.recordMetric(
    "Canary failure rate",
    "pkr/runtime-tests",
    "P7D",
    { operator: "lte", value: 0.1, severity: "error" },
    0.25,
    runtime.ownerId(),
    "command_metric_breached",
  );
  const breachedMetricId = objectId(breachedMetric.value as JsonObject);
  assert.equal(((breachedMetric.value as JsonObject).status as JsonObject).phase, "breached");
  const beforeStaleMetric = runtime.stateDigest();
  await assert.rejects(
    evolution.observe(
      workflowCandidate({ version: "0.8.41" }),
      { rule: "metric-threshold", metric: { id: breachedMetricId, revision: 2 } },
      "agent_metric_proposer",
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-007",
  );
  assert.equal(runtime.stateDigest(), beforeStaleMetric);
  const metricProposal = await evolution.observe(
    workflowCandidate({ version: "0.8.5", expectedImprovement: "Restore the declared failure-rate threshold." }),
    { rule: "metric-threshold", metric: { id: breachedMetricId, revision: 1 } },
    "agent_metric_proposer",
    "command_metric_breach_propose",
  );
  const metricIssue = runtime.getRecord("Issue", (metricProposal.value as JsonObject).issueId as string);
  assert.equal((metricIssue.data.spec as JsonObject).severity, "error");
  assert.equal(runtime.getRecord("PackageInstallation", baseInstallationId).data.state, "active");

  const candidateFile = join(root, "human-feedback-candidate.json");
  const observationFile = join(root, "human-feedback-observation.json");
  const beforeAgentFeedback = runtime.stateDigest();
  await assert.rejects(
    evolution.observe(
      workflowCandidate({ version: "0.8.51" }),
      {
        rule: "human-feedback",
        submittedBy: "agent_fake_human",
        feedback: "This must not be accepted as human feedback.",
        impact: "Misattribution would bypass provenance.",
      },
      "agent_steward_observer",
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-007",
  );
  assert.equal(runtime.stateDigest(), beforeAgentFeedback);
  await writeFile(candidateFile, JSON.stringify(workflowCandidate({ version: "0.8.6" })), "utf8");
  await writeFile(observationFile, JSON.stringify({
    rule: "human-feedback",
    submittedBy: runtime.ownerId(),
    feedback: "The default Agent loop must explain why promotion is blocked.",
    impact: "Opaque blocked states prevent first-time users from recovering without source inspection.",
  }), "utf8");
  runtime.close();

  const humanProposal = runCli(root, [
    "evolution",
    "observe",
    "--candidate-file",
    candidateFile,
    "--observation-file",
    observationFile,
    "--proposer",
    "agent_steward_observer",
    "--command-id",
    "command_human_feedback_propose",
  ]);
  const reopened = await PkrRuntime.open(root, repositoryRoot);
  const humanIssue = reopened.getRecord(
    "Issue",
    (humanProposal.value as JsonObject).issueId as string,
  );
  assert.equal((humanIssue.data.spec as JsonObject).issueType, "feedback");
  const humanObservations = (humanIssue.data.extensions as JsonObject)[
    "pkr.evolution/observations"
  ] as JsonObject[];
  assert.equal(humanObservations[0]!.submittedBy, reopened.ownerId());
  assert.equal(humanObservations[0]!.state, "recorded");
  assert.equal(reopened.getRecord("PackageInstallation", baseInstallationId).data.state, "active");
  reopened.close();
});

test("Prompt candidates replay deterministically, activate atomically, fail closed, and roll back with history", async () => {
  const setup = await evolutionProject("prompt-evolution");
  const templateFile = join(setup.root, "baseline-prompt.txt");
  await writeFile(
    templateFile,
    "Project {{project.name}}. Report task outcome.",
    "utf8",
  );
  setup.runtime.close();
  const registered = runCli(setup.root, [
    "prompt",
    "register",
    "--title",
    "Baseline Agent prompt",
    "--template-file",
    templateFile,
    "--version",
    "1.0.0",
    "--command-id",
    "command_prompt_register",
  ]);
  const baselinePromptId = objectId(registered.value as JsonObject);

  const runtime = await PkrRuntime.open(setup.root, repositoryRoot);
  const evolution = new EvolutionService(runtime);
  const baselineStatus = runtime.promptStatus(baselinePromptId);
  const baselineDigest = baselineStatus.contentDigest as string;
  assert.equal(baselineStatus.phase, "active");

  const beforeStaleCandidate = runtime.stateDigest();
  await assert.rejects(
    evolution.observeRepeatedFailures(
      promptCandidate(baselinePromptId, "sha256:0000000000000000"),
      "agent_prompt_proposer",
      2,
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-004",
  );
  assert.equal(runtime.stateDigest(), beforeStaleCandidate);

  const beforeNoopCandidate = runtime.stateDigest();
  await assert.rejects(
    evolution.observeRepeatedFailures(
      promptCandidate(baselinePromptId, baselineDigest, {
        version: "1.0.0",
        template: "Project {{project.name}}. Report task outcome.",
        requiredIncludes: ["Project PKR", "Report task outcome"],
      }),
      "agent_prompt_proposer",
      2,
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-008",
  );
  assert.equal(runtime.stateDigest(), beforeNoopCandidate);

  const proposed = await evolution.observeRepeatedFailures(
    promptCandidate(baselinePromptId, baselineDigest),
    "agent_prompt_proposer",
    2,
    "command_prompt_candidate_propose",
  );
  const candidateId = (proposed.value as JsonObject).candidateId as string;
  assert.equal(runtime.promptStatus(baselinePromptId).phase, "active");
  const evaluated = await evolution.evaluate(
    candidateId,
    "agent_prompt_verifier",
    "command_prompt_candidate_evaluate",
  );
  assert.equal((evaluated.value as JsonObject).passed, true);
  assert.equal(runtime.promptStatus(baselinePromptId).phase, "active");
  await evolution.approve(candidateId, runtime.ownerId(), "command_prompt_candidate_approve");

  const promoted = await evolution.promote(
    candidateId,
    runtime.ownerId(),
    undefined,
    "command_prompt_candidate_promote",
  );
  const promotedPromptId = (promoted.value as JsonObject).promptId as string;
  assert.equal(runtime.promptStatus(baselinePromptId).phase, "deprecated");
  assert.equal(runtime.promptStatus(promotedPromptId).phase, "active");
  assert.equal(evolution.status(candidateId).state, "active");
  assert.equal(evolution.status(candidateId).monitoringState, "pending");
  await assert.rejects(
    evolution.monitor(candidateId, "agent_prompt_proposer", true),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-002",
  );
  const monitored = runCli(setup.root, [
    "evolution",
    "monitor",
    "--id",
    candidateId,
    "--observer",
    "agent_prompt_monitor",
    "--value",
    "true",
    "--command-id",
    "command_prompt_candidate_monitor",
  ]);
  assert.equal((monitored.value as JsonObject).state, "healthy");
  assert.equal(evolution.status(candidateId).monitoringState, "healthy");
  const verificationIds = runtime.listRecords("Verification").map((record) => record.id);
  const decisionIds = runtime.listRecords("Decision").map((record) => record.id);
  const monitoringIds = evolution.status(candidateId).monitoringIds as string[];

  await runtime.rollbackPrompt(
    promotedPromptId,
    baselinePromptId,
    runtime.ownerId(),
    "command_prompt_candidate_rollback",
  );
  assert.equal(runtime.promptStatus(baselinePromptId).phase, "active");
  assert.equal(runtime.promptStatus(promotedPromptId).phase, "deprecated");
  assert.equal(evolution.status(candidateId).state, "rolledBack");
  assert.deepEqual(runtime.listRecords("Verification").map((record) => record.id), verificationIds);
  assert.deepEqual(runtime.listRecords("Decision").map((record) => record.id), decisionIds);
  assert.deepEqual(evolution.status(candidateId).monitoringIds, monitoringIds);
  await assert.rejects(
    evolution.promote(candidateId, runtime.ownerId()),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-004",
  );

  const failedProposal = await evolution.observeRepeatedFailures(
    promptCandidate(baselinePromptId, baselineDigest, {
      version: "1.2.0",
      maxRenderedCharacters: 10,
    }),
    "agent_prompt_failure_proposer",
    2,
    "command_prompt_failure_propose",
  );
  const failedCandidateId = (failedProposal.value as JsonObject).candidateId as string;
  const failedEvaluation = await evolution.evaluate(
    failedCandidateId,
    "agent_prompt_failure_verifier",
    "command_prompt_failure_evaluate",
  );
  assert.equal((failedEvaluation.value as JsonObject).passed, false);
  assert.equal(((failedEvaluation.value as JsonObject).result as JsonObject).aborted, true);
  await assert.rejects(
    evolution.approve(failedCandidateId, runtime.ownerId()),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-005",
  );
  await assert.rejects(
    evolution.promote(failedCandidateId, runtime.ownerId()),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-005",
  );
  assert.equal(runtime.promptStatus(baselinePromptId).phase, "active");
  assert.equal(runtime.listRecords("Knowledge").filter((record) =>
    (record.data.spec as JsonObject).knowledgeType === "prompt" &&
    (record.data.status as JsonObject).phase === "active",
  ).length, 1);
  runtime.close();

  const cliStatus = runCli(setup.root, ["prompt", "status", "--id", baselinePromptId]);
  assert.equal(cliStatus.phase, "active");
  assert.equal(cliStatus.contentDigest, baselineDigest);
});

test("Policy candidates preserve invariants, activate atomically, and roll back to a fresh Constraint", async () => {
  const setup = await evolutionProject("policy-evolution");
  const baseline = governancePolicy();
  const policyFile = join(setup.root, "baseline-policy.json");
  await writeFile(policyFile, JSON.stringify(baseline), "utf8");
  setup.runtime.close();

  const registered = runCli(setup.root, [
    "policy",
    "register",
    "--policy-file",
    policyFile,
    "--command-id",
    "command_policy_register",
  ]);
  const baselinePolicyId = objectId(registered.value as JsonObject);
  const runtime = await PkrRuntime.open(setup.root, repositoryRoot);
  const evolution = new EvolutionService(runtime);
  const baselineStatus = runtime.policyStatus(baselinePolicyId);
  const baselineDigest = baselineStatus.contentDigest as string;
  assert.equal(baselineStatus.phase, "active");

  for (const protection of [
    "ownerApprovalRequired",
    "auditRetention",
    "verificationRequired",
    "rollbackRequired",
  ] as const) {
    const weakened = JSON.parse(JSON.stringify(baseline)) as GovernancePolicyContent;
    if (protection === "auditRetention") {
      weakened.protections.auditRetention = "mutable";
    } else {
      weakened.protections[protection] = false;
    }
    const beforeWeakening = runtime.stateDigest();
    await assert.rejects(
      runtime.registerPolicy(weakened, runtime.ownerId()),
      (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-010",
    );
    assert.equal(runtime.stateDigest(), beforeWeakening);
  }

  const bypassingDecisionTable = JSON.parse(JSON.stringify(baseline)) as GovernancePolicyContent;
  bypassingDecisionTable.version = "1.0.1-invalid";
  bypassingDecisionTable.rules.unshift({
    id: "allow-unapproved-promotion",
    action: "pkr/promote",
    effect: "allow",
    when: { op: "not", expression: { op: "exists", path: "never" } },
  });
  const beforeDecisionTableBypass = runtime.stateDigest();
  await assert.rejects(
    runtime.registerPolicy(bypassingDecisionTable, runtime.ownerId()),
    (error: unknown) => error instanceof PkrError &&
      error.code === "PKR-EVOLUTION-010" &&
      error.message.includes("weakens a protected governance invariant"),
  );
  assert.equal(runtime.stateDigest(), beforeDecisionTableBypass);

  const beforeStaleCandidate = runtime.stateDigest();
  await assert.rejects(
    evolution.observeRepeatedFailures(
      policyCandidate(baselinePolicyId, "sha256:0000000000000000"),
      "agent_policy_proposer",
      2,
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-004",
  );
  assert.equal(runtime.stateDigest(), beforeStaleCandidate);

  const beforeNoopCandidate = runtime.stateDigest();
  await assert.rejects(
    evolution.observeRepeatedFailures(
      policyCandidate(baselinePolicyId, baselineDigest, { policy: baseline }),
      "agent_policy_proposer",
      2,
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-010",
  );
  assert.equal(runtime.stateDigest(), beforeNoopCandidate);

  const proposed = await evolution.observeRepeatedFailures(
    policyCandidate(baselinePolicyId, baselineDigest),
    "agent_policy_proposer",
    2,
    "command_policy_candidate_propose",
  );
  const candidateId = (proposed.value as JsonObject).candidateId as string;
  const evaluated = await evolution.evaluate(
    candidateId,
    "agent_policy_verifier",
    "command_policy_candidate_evaluate",
  );
  const evaluationResult = (evaluated.value as JsonObject).result as JsonObject;
  const replay = evaluationResult.scenarios as JsonObject[];
  assert.equal((evaluated.value as JsonObject).passed, true);
  assert.equal(replay[0]!.effect, "allow");
  assert.equal(replay[0]!.matchedRule, "allow-governed-promotion");
  assert.equal(replay[1]!.effect, "deny");
  assert.equal(replay[1]!.matchedRule, null);
  assert.equal(typeof replay[0]!.rulesEvaluated, "number");
  await evolution.approve(candidateId, runtime.ownerId(), "command_policy_candidate_approve");

  const promoted = await evolution.promote(
    candidateId,
    runtime.ownerId(),
    undefined,
    "command_policy_candidate_promote",
  );
  const promotedPolicyId = (promoted.value as JsonObject).policyId as string;
  assert.equal(runtime.policyStatus(baselinePolicyId).phase, "retired");
  assert.equal(runtime.policyStatus(promotedPolicyId).phase, "active");
  assert.equal(evolution.status(candidateId).state, "active");
  assert.equal(runtime.listRecords("Constraint").filter((record) =>
    (record.data.status as JsonObject).phase === "active",
  ).length, 1);

  runtime.close();
  const rolledBack = runCli(setup.root, [
    "policy",
    "rollback",
    "--current",
    promotedPolicyId,
    "--target",
    baselinePolicyId,
    "--command-id",
    "command_policy_candidate_rollback",
  ]);
  const restoredPolicyId = (rolledBack.value as JsonObject).policyId as string;
  assert.notEqual(restoredPolicyId, baselinePolicyId);
  assert.notEqual(restoredPolicyId, promotedPolicyId);

  const reopened = await PkrRuntime.open(setup.root, repositoryRoot);
  const reopenedEvolution = new EvolutionService(reopened);
  assert.equal(reopened.policyStatus(baselinePolicyId).phase, "retired");
  assert.equal(reopened.policyStatus(promotedPolicyId).phase, "retired");
  assert.equal(reopened.policyStatus(restoredPolicyId).phase, "active");
  assert.equal(reopened.policyStatus(restoredPolicyId).contentDigest, baselineDigest);
  assert.equal(reopenedEvolution.status(candidateId).state, "rolledBack");
  await assert.rejects(
    reopenedEvolution.promote(candidateId, reopened.ownerId()),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-004",
  );

  const failedProposal = await reopenedEvolution.observeRepeatedFailures(
    policyCandidate(restoredPolicyId, baselineDigest, {
      policy: governancePolicy("1.2.0", "Budget-aborted Policy candidate"),
      maxRulesEvaluated: 1,
      scenarios: [{
        name: "release-budget",
        action: "pkr/release",
        context: { ownerApproved: true },
        expectedEffect: "allow",
      }],
    }),
    "agent_policy_budget_proposer",
    2,
    "command_policy_budget_propose",
  );
  const failedCandidateId = (failedProposal.value as JsonObject).candidateId as string;
  const failedEvaluation = await reopenedEvolution.evaluate(
    failedCandidateId,
    "agent_policy_budget_verifier",
    "command_policy_budget_evaluate",
  );
  assert.equal((failedEvaluation.value as JsonObject).passed, false);
  assert.equal(((failedEvaluation.value as JsonObject).result as JsonObject).aborted, true);
  assert.equal(((failedEvaluation.value as JsonObject).result as JsonObject).rulesEvaluated, 1);
  await assert.rejects(
    reopenedEvolution.promote(failedCandidateId, reopened.ownerId()),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-005",
  );
  assert.equal(reopened.listRecords("Constraint").filter((record) =>
    (record.data.status as JsonObject).phase === "active",
  ).length, 1);
  const cliStatus = runCli(setup.root, ["policy", "status", "--id", restoredPolicyId]);
  assert.equal(cliStatus.phase, "active");
  assert.equal(cliStatus.contentDigest, baselineDigest);
  reopened.close();
});

test("Adapter candidates constrain real Session bindings and revoke callbacks after rollback", async () => {
  const setup = await evolutionProject("adapter-evolution");
  const baseline = managedAdapter();
  const adapterFile = join(setup.root, "baseline-adapter.json");
  await writeFile(adapterFile, JSON.stringify(baseline), "utf8");
  setup.runtime.close();

  const registered = runCli(setup.root, [
    "adapter",
    "register",
    "--adapter-file",
    adapterFile,
    "--command-id",
    "command_adapter_register",
  ]);
  const baselineAdapterVersionId = objectId(registered.value as JsonObject);
  const runtime = await PkrRuntime.open(setup.root, repositoryRoot);
  const evolution = new EvolutionService(runtime);
  const baselineStatus = runtime.adapterStatus(baselineAdapterVersionId);
  const baselineDigest = baselineStatus.contentDigest as string;
  assert.equal(baselineStatus.phase, "active");

  const excessive = managedAdapter("0.7.0", "2", [
    "filesystem.read",
    "filesystem.write",
    "terminal",
    "network",
  ]);
  const beforeExcessive = runtime.stateDigest();
  await assert.rejects(
    evolution.observeRepeatedFailures(
      adapterCandidate(baselineAdapterVersionId, baselineDigest, { adapter: excessive }),
      "agent_adapter_proposer",
      2,
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-012",
  );
  assert.equal(runtime.stateDigest(), beforeExcessive);

  const understatedRemoval = managedAdapter("0.7.0", "2", [
    "filesystem.read",
    "filesystem.write",
  ]);
  const beforeUnderstatedRemoval = runtime.stateDigest();
  await assert.rejects(
    evolution.observeRepeatedFailures(
      adapterCandidate(baselineAdapterVersionId, baselineDigest, {
        adapter: understatedRemoval,
        permissionRemove: [],
      }),
      "agent_adapter_proposer",
      2,
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-012",
  );
  assert.equal(runtime.stateDigest(), beforeUnderstatedRemoval);

  const beforeStale = runtime.stateDigest();
  await assert.rejects(
    evolution.observeRepeatedFailures(
      adapterCandidate(baselineAdapterVersionId, "sha256:0000000000000000"),
      "agent_adapter_proposer",
      2,
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-004",
  );
  assert.equal(runtime.stateDigest(), beforeStale);

  const beforeNoop = runtime.stateDigest();
  await assert.rejects(
    evolution.observeRepeatedFailures(
      adapterCandidate(baselineAdapterVersionId, baselineDigest, { adapter: baseline }),
      "agent_adapter_proposer",
      2,
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-012",
  );
  assert.equal(runtime.stateDigest(), beforeNoop);

  const proposed = await evolution.observeRepeatedFailures(
    adapterCandidate(baselineAdapterVersionId, baselineDigest),
    "agent_adapter_proposer",
    2,
    "command_adapter_candidate_propose",
  );
  const candidateId = (proposed.value as JsonObject).candidateId as string;
  const evaluated = await evolution.evaluate(
    candidateId,
    "agent_adapter_verifier",
    "command_adapter_candidate_evaluate",
  );
  const replay = ((evaluated.value as JsonObject).result as JsonObject).scenarios as JsonObject[];
  assert.equal((evaluated.value as JsonObject).passed, true);
  assert.equal(replay[0]!.accepted, true);
  assert.equal(replay[1]!.accepted, false);
  assert.equal(replay[1]!.callbackFailure, "VerifiedCallbackRequiresEvidenceAndNoResidualWork");
  await evolution.approve(candidateId, runtime.ownerId(), "command_adapter_candidate_approve");

  const promoted = await evolution.promote(
    candidateId,
    runtime.ownerId(),
    undefined,
    "command_adapter_candidate_promote",
  );
  const promotedAdapterVersionId = (promoted.value as JsonObject).adapterVersionId as string;
  assert.equal(runtime.adapterStatus(baselineAdapterVersionId).phase, "retired");
  assert.equal(runtime.adapterStatus(promotedAdapterVersionId).phase, "active");
  assert.equal(evolution.status(candidateId).state, "active");

  const executionGoal = await runtime.createGoal("Bind execution to the active Adapter contract");
  const executionTask = await runtime.createTask(
    objectId(executionGoal.value as JsonObject),
    "Reject stale provider versions before dispatch",
  );
  const executionAgent = await runtime.registerAgent("adapter-bound-worker", "local-process");
  const executionTaskId = objectId(executionTask.value as JsonObject);
  const executionAgentId = objectId(executionAgent.value as JsonObject);
  const beforeOldProvider = runtime.stateDigest();
  await assert.rejects(
    runtime.dispatch(
      executionTaskId,
      executionAgentId,
      "command_adapter_old_provider",
      {
        executionMode: "adapter",
        providerBinding: {
          id: "pkr.adapter.local-process",
          version: "0.6.0",
          capabilities: ["filesystem.read", "filesystem.write", "terminal"],
        },
      },
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-012",
  );
  assert.equal(runtime.stateDigest(), beforeOldProvider);

  const dispatch = await runtime.dispatch(
    executionTaskId,
    executionAgentId,
    "command_adapter_bound_dispatch",
    {
      id: "pkr.adapter.local-process",
      version: "0.7.0",
      capabilities: ["filesystem.read", "filesystem.write", "terminal"],
    },
  );
  const assignmentId = (dispatch.value as JsonObject).assignmentId as string;
  const sessionId = (dispatch.value as JsonObject).sessionId as string;
  const session = runtime.getRecord("AgentSession", sessionId);
  const sessionAdapter = session.data.adapter as JsonObject;
  const sessionBinding = (session.data.extensions as JsonObject)["pkr.adapter/version"] as JsonObject;
  const capability = runtime.getRecord(
    "CapabilityStatement",
    session.data.capabilityStatementId as string,
  );
  assert.equal(sessionAdapter.version, "0.7.0");
  assert.equal(sessionBinding.adapterVersionId, promotedAdapterVersionId);
  assert.equal(
    ((capability.data.extensions as JsonObject)["pkr.adapter/version"] as JsonObject).adapterVersionId,
    promotedAdapterVersionId,
  );
  const beforeInvalidLiveCallback = runtime.stateDigest();
  await assert.rejects(
    runtime.callback(
      assignmentId,
      "verified",
      [],
      "command_adapter_invalid_live_callback",
      {
        outcome: "verified",
        completed: ["adapter-bound-dispatch"],
        incomplete: [],
        blockers: [],
        evidenceIds: [],
        outputs: [{ kind: "result", locator: "pkr://adapter-runtime/rejected" }],
        nextAction: "Do not accept this callback.",
      },
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-COORD-008",
  );
  assert.equal(runtime.stateDigest(), beforeInvalidLiveCallback);
  const liveCallback: JsonObject = {
    outcome: "verified",
    completed: ["adapter-bound-dispatch"],
    incomplete: [],
    blockers: [],
    evidenceIds: ["artifact_adapter_runtime"],
    outputs: [{ kind: "artifact", locator: "pkr://adapter-runtime/artifact" }],
    nextAction: "Submit independent Verification.",
  };
  const callbackFile = join(setup.root, "adapter-callback.json");
  await writeFile(callbackFile, JSON.stringify(liveCallback), "utf8");
  const acceptedCallback = runCli(setup.root, [
    "callback",
    "--assignment",
    assignmentId,
    "--callback-file",
    callbackFile,
    "--command-id",
    "command_adapter_live_callback",
  ]);
  assert.equal((acceptedCallback.value as JsonObject).outcome, "verified");

  const revokedTask = await runtime.createTask(
    objectId(executionGoal.value as JsonObject),
    "Revoke callback authority when its Adapter is rolled back",
  );
  const revokedDispatch = await runtime.dispatch(
    objectId(revokedTask.value as JsonObject),
    executionAgentId,
    "command_adapter_revoked_dispatch",
    {
      id: "pkr.adapter.local-process",
      version: "0.7.0",
      capabilities: ["filesystem.read", "filesystem.write", "terminal"],
    },
  );
  const revokedAssignmentId = (revokedDispatch.value as JsonObject).assignmentId as string;

  runtime.close();
  const rolledBack = runCli(setup.root, [
    "adapter",
    "rollback",
    "--current",
    promotedAdapterVersionId,
    "--target",
    baselineAdapterVersionId,
    "--command-id",
    "command_adapter_candidate_rollback",
  ]);
  const restoredAdapterVersionId = (rolledBack.value as JsonObject).adapterVersionId as string;
  assert.notEqual(restoredAdapterVersionId, baselineAdapterVersionId);
  assert.notEqual(restoredAdapterVersionId, promotedAdapterVersionId);

  const reopened = await PkrRuntime.open(setup.root, repositoryRoot);
  const reopenedEvolution = new EvolutionService(reopened);
  assert.equal(reopened.adapterStatus(baselineAdapterVersionId).phase, "retired");
  assert.equal(reopened.adapterStatus(promotedAdapterVersionId).phase, "retired");
  assert.equal(reopened.adapterStatus(restoredAdapterVersionId).phase, "active");
  assert.equal(reopened.adapterStatus(restoredAdapterVersionId).contentDigest, baselineDigest);
  assert.equal(reopenedEvolution.status(candidateId).state, "rolledBack");
  const beforeRevokedCallback = reopened.stateDigest();
  await assert.rejects(
    reopened.callback(
      revokedAssignmentId,
      "verified",
      ["artifact_adapter_runtime"],
      "command_adapter_revoked_callback",
      liveCallback,
    ),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-COORD-008",
  );
  assert.equal(reopened.stateDigest(), beforeRevokedCallback);
  await assert.rejects(
    reopenedEvolution.promote(candidateId, reopened.ownerId()),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-004",
  );

  const failedProposal = await reopenedEvolution.observeRepeatedFailures(
    adapterCandidate(restoredAdapterVersionId, baselineDigest, {
      adapter: managedAdapter("0.8.0", "3"),
      maxPayloadBytes: 1,
    }),
    "agent_adapter_budget_proposer",
    2,
    "command_adapter_budget_propose",
  );
  const failedCandidateId = (failedProposal.value as JsonObject).candidateId as string;
  const failedEvaluation = await reopenedEvolution.evaluate(
    failedCandidateId,
    "agent_adapter_budget_verifier",
    "command_adapter_budget_evaluate",
  );
  assert.equal((failedEvaluation.value as JsonObject).passed, false);
  assert.equal(((failedEvaluation.value as JsonObject).result as JsonObject).aborted, true);
  await assert.rejects(
    reopenedEvolution.promote(failedCandidateId, reopened.ownerId()),
    (error: unknown) => error instanceof PkrError && error.code === "PKR-EVOLUTION-005",
  );
  assert.equal(reopened.listRecords("Artifact").filter((record) => {
    const extension = (record.data.extensions as JsonObject)["pkr.adapter/version"] as JsonObject | undefined;
    return extension?.adapterId === baseline.adapterId && extension.state === "active";
  }).length, 1);
  const cliStatus = runCli(setup.root, ["adapter", "status", "--id", restoredAdapterVersionId]);
  assert.equal(cliStatus.phase, "active");
  assert.equal(cliStatus.contentDigest, baselineDigest);
  reopened.close();
});
