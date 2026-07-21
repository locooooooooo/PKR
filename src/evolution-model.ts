import { PkrError } from "./errors.js";
import { providerCallbackFailure } from "./provider-contract.js";
import { isBoundedCallbackPayload, isSafeOutputLocator } from "./security.js";
import type { ProfilePackage } from "./profiles.js";
import type { JsonObject, JsonValue, MetricThreshold } from "./types.js";
import { digest } from "./util.js";
import {
  evaluateExpression,
  parseWorkflowDefinition,
  type PortableExpression,
} from "./workflow.js";

export interface CanaryStep {
  to: string;
  context: JsonObject;
}

export interface CanaryScenario {
  name: string;
  steps: CanaryStep[];
  expectedFinalState: string;
}

export interface CanaryPlan {
  maxScenarios: number;
  maxTransitions: number;
  requiredSuccessRate: number;
  baselineSuccessRate: number;
  maxRegression: number;
  protectedOutputScope: string[];
  scenarios: CanaryScenario[];
}

export interface EvolutionMonitoringPlan {
  measure: string;
  window: string;
  maxObservations: number;
  threshold: MetricThreshold;
  onBreach: "require-rollback";
}

export interface PromptCandidateContent {
  version: string;
  title: string;
  template: string;
  variables: string[];
}

export interface PromptCanaryScenario {
  name: string;
  input: JsonObject;
  requiredIncludes: string[];
  forbiddenIncludes: string[];
}

export interface PromptCanaryPlan {
  maxScenarios: number;
  maxRenderedCharacters: number;
  requiredSuccessRate: number;
  baselineSuccessRate: number;
  maxRegression: number;
  protectedOutputScope: string[];
  scenarios: PromptCanaryScenario[];
}

export interface ManagedAdapterIsolation {
  filesystem: "scoped";
  network: "none";
  credentials: "references-only";
}

export interface ManagedAdapterContent {
  adapterId: string;
  version: string;
  title: string;
  implementationDigest: string;
  protocolVersion: "pkr.dev/v0.4";
  executionMode: "isolated-process";
  authority: "non-authoritative";
  capabilities: string[];
  isolation: ManagedAdapterIsolation;
}

export interface AdapterCanaryScenario {
  name: string;
  requiredCapabilities: string[];
  callback: JsonObject;
  expectedAccepted: boolean;
}

export interface AdapterCanaryPlan {
  maxScenarios: number;
  maxPayloadBytes: number;
  requiredSuccessRate: number;
  baselineSuccessRate: number;
  maxRegression: number;
  protectedOutputScope: string[];
  scenarios: AdapterCanaryScenario[];
}

export interface GovernancePolicyProtections {
  ownerApprovalRequired: boolean;
  auditRetention: "immutable" | "mutable";
  verificationRequired: boolean;
  rollbackRequired: boolean;
}

export interface GovernancePolicyRule {
  id: string;
  action: string;
  effect: "allow" | "deny";
  when: PortableExpression;
}

export interface GovernancePolicyContent {
  version: string;
  title: string;
  rule: string;
  scopeKinds: string[];
  severity: "error" | "critical";
  enforcement: "blocking";
  protections: GovernancePolicyProtections;
  defaultEffect: "allow" | "deny";
  rules: GovernancePolicyRule[];
}

export interface PolicyCanaryScenario {
  name: string;
  action: string;
  context: JsonObject;
  expectedEffect: "allow" | "deny";
}

export interface PolicyCanaryPlan {
  maxScenarios: number;
  maxRulesEvaluated: number;
  requiredSuccessRate: number;
  baselineSuccessRate: number;
  maxRegression: number;
  protectedOutputScope: string[];
  scenarios: PolicyCanaryScenario[];
}

export interface EvolutionCandidateSpec {
  targetKind: "workflow" | "prompt" | "policy" | "adapter" | "runtime";
  targetId: string;
  activeVersion: string;
  expectedImprovement: string;
  nonGoals: string[];
  permissionDelta: { add: string[]; remove: string[] };
  profile?: ProfilePackage;
  prompt?: PromptCandidateContent;
  policy?: GovernancePolicyContent;
  adapter?: ManagedAdapterContent;
  runtimeVersion?: string;
  canary: CanaryPlan | PromptCanaryPlan | PolicyCanaryPlan | AdapterCanaryPlan;
  monitoring: EvolutionMonitoringPlan;
}

export interface EvolutionObservationReference {
  id: string;
  revision: number;
}

export type EvolutionObservationSpec =
  | { rule: "repeated-failure"; threshold?: number }
  | {
      rule: "assurance-debt";
      threshold?: number;
      verificationRefs?: EvolutionObservationReference[];
    }
  | { rule: "metric-threshold"; metric: EvolutionObservationReference }
  | {
      rule: "human-feedback";
      submittedBy: string;
      feedback: string;
      impact: string;
    };

const PRINCIPAL_ID = /^[a-z][a-z0-9-]{0,31}_[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

export function validateEvolutionObservation(observation: EvolutionObservationSpec): void {
  if (!observation || !["repeated-failure", "assurance-debt", "metric-threshold", "human-feedback"].includes(observation.rule)) {
    throw new PkrError("PKR-EVOLUTION-007", "unsupported evolution observation rule");
  }
  if (observation.rule === "repeated-failure") {
    if (observation.threshold !== undefined &&
      (!Number.isInteger(observation.threshold) || observation.threshold < 2)) {
      throw new PkrError(
        "PKR-EVOLUTION-007",
        "repeated-failure threshold must be an integer of at least 2",
      );
    }
    return;
  }
  if (observation.rule === "assurance-debt") {
    if (observation.threshold !== undefined &&
      (!Number.isInteger(observation.threshold) || observation.threshold < 1)) {
      throw new PkrError(
        "PKR-EVOLUTION-007",
        "assurance-debt threshold must be a positive integer",
      );
    }
    if (observation.verificationRefs !== undefined) {
      const keys = observation.verificationRefs.map((reference) => `${reference.id}@${reference.revision}`);
      if (
        observation.verificationRefs.length === 0 ||
        observation.verificationRefs.some((reference) =>
          !reference.id || !Number.isInteger(reference.revision) || reference.revision < 1
        ) ||
        new Set(keys).size !== keys.length
      ) {
        throw new PkrError(
          "PKR-EVOLUTION-007",
          "assurance-debt references must be unique exact Verification revisions",
        );
      }
    }
    return;
  }
  if (observation.rule === "metric-threshold") {
    if (
      !observation.metric ||
      !observation.metric.id ||
      !Number.isInteger(observation.metric.revision) ||
      observation.metric.revision < 1
    ) {
      throw new PkrError(
        "PKR-EVOLUTION-007",
        "metric-threshold observation requires an exact Metric revision",
      );
    }
    return;
  }
  if (
    !PRINCIPAL_ID.test(observation.submittedBy) ||
    observation.submittedBy.startsWith("agent_") ||
    !observation.feedback.trim() ||
    observation.feedback.length > 10000 ||
    !observation.impact.trim() ||
    observation.impact.length > 10000
  ) {
    throw new PkrError(
      "PKR-EVOLUTION-007",
      "human feedback requires an attributed human principal, feedback, and impact",
    );
  }
}

const PROMPT_PATH = /^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*$/;
const PROMPT_TOKEN = /{{\s*([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*)\s*}}/g;

function invalidCommonCanary(
  canary: CanaryPlan | PromptCanaryPlan | PolicyCanaryPlan | AdapterCanaryPlan,
): boolean {
  return !canary ||
    !Number.isInteger(canary.maxScenarios) ||
    canary.maxScenarios < 1 ||
    canary.maxScenarios > 100 ||
    !Number.isFinite(canary.requiredSuccessRate) ||
    canary.requiredSuccessRate < 0 ||
    canary.requiredSuccessRate > 1 ||
    !Number.isFinite(canary.baselineSuccessRate) ||
    canary.baselineSuccessRate < 0 ||
    canary.baselineSuccessRate > 1 ||
    !Number.isFinite(canary.maxRegression) ||
    canary.maxRegression < 0 ||
    !Array.isArray(canary.scenarios) ||
    canary.scenarios.length === 0 ||
    !Array.isArray(canary.protectedOutputScope) ||
    canary.protectedOutputScope.length === 0 ||
    canary.protectedOutputScope.some((scope) => typeof scope !== "string" || !scope);
}

export function promptTemplateVariables(template: string): string[] {
  const variables = [...template.matchAll(PROMPT_TOKEN)].map((match) => match[1]!);
  if (/{{|}}/.test(template.replace(PROMPT_TOKEN, ""))) {
    throw new PkrError("PKR-EVOLUTION-008", "Prompt template contains invalid placeholder syntax");
  }
  return [...new Set(variables)];
}

const ADAPTER_ID = /^[a-z][a-z0-9.-]{2,127}$/;
const ADAPTER_CAPABILITY = /^[a-z][a-z0-9.-]{0,63}$/;
const ADAPTER_DIGEST = /^sha256:[a-f0-9]{64}$/;
const ADAPTER_CAPABILITY_CEILING = new Set([
  "filesystem.read",
  "filesystem.write",
  "terminal",
]);
export function validateManagedAdapter(adapter: ManagedAdapterContent): void {
  const capabilities = adapter?.capabilities ?? [];
  if (
    !adapter ||
    !ADAPTER_ID.test(adapter.adapterId) ||
    !adapter.version?.trim() ||
    adapter.version.length > 128 ||
    !adapter.title?.trim() ||
    adapter.title.length > 256 ||
    !ADAPTER_DIGEST.test(adapter.implementationDigest) ||
    adapter.protocolVersion !== "pkr.dev/v0.4" ||
    adapter.executionMode !== "isolated-process" ||
    adapter.authority !== "non-authoritative" ||
    !Array.isArray(capabilities) ||
    capabilities.length === 0 ||
    capabilities.some((capability) =>
      !ADAPTER_CAPABILITY.test(capability) || !ADAPTER_CAPABILITY_CEILING.has(capability)
    ) ||
    new Set(capabilities).size !== capabilities.length ||
    adapter.isolation?.filesystem !== "scoped" ||
    adapter.isolation.network !== "none" ||
    adapter.isolation.credentials !== "references-only"
  ) {
    throw new PkrError(
      "PKR-EVOLUTION-012",
      "Adapter must remain isolated, non-authoritative, and within the kernel capability ceiling",
    );
  }
}

export function adapterCallbackFailure(callback: JsonObject): string | null {
  const contractFailure = providerCallbackFailure(callback);
  if (contractFailure) return contractFailure;
  if (
    !isBoundedCallbackPayload(callback) ||
    (callback.outputs as JsonObject[]).some((output) => !isSafeOutputLocator(output.locator))
  ) {
    return "InvalidCallbackShape";
  }
  return null;
}

const POLICY_RULE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/;
const POLICY_ACTIONS = new Set([
  "pkr/promote",
  "pkr/permission-change",
  "pkr/rollback",
  "pkr/release",
]);
const POLICY_SCOPE_KINDS = new Set([
  "Mission", "Goal", "Task", "Knowledge", "Decision", "Constraint", "Workflow",
  "Verification", "Artifact", "Metric", "Agent", "Role", "Issue", "Release",
]);
const REQUIRED_POLICY_SCOPE = [
  "Decision", "Constraint", "Workflow", "Verification", "Artifact", "Role", "Release",
];

function evaluatePolicyRules(
  policy: GovernancePolicyContent,
  action: string,
  context: JsonObject,
  maxRulesEvaluated = Number.POSITIVE_INFINITY,
): {
  effect: "allow" | "deny" | null;
  matchedRule: string | null;
  rulesEvaluated: number;
  aborted: boolean;
} {
  let rulesEvaluated = 0;
  for (const rule of policy.rules) {
    if (rulesEvaluated >= maxRulesEvaluated) {
      return { effect: null, matchedRule: null, rulesEvaluated, aborted: true };
    }
    rulesEvaluated += 1;
    if (rule.action === action && evaluateExpression(rule.when, context)) {
      return {
        effect: rule.effect,
        matchedRule: rule.id,
        rulesEvaluated,
        aborted: false,
      };
    }
  }
  return {
    effect: policy.defaultEffect,
    matchedRule: null,
    rulesEvaluated,
    aborted: false,
  };
}

export function validateGovernancePolicy(policy: GovernancePolicyContent): void {
  const protections = policy?.protections;
  const ruleIds = policy?.rules?.map((rule) => rule.id) ?? [];
  if (
    !policy ||
    !policy.version?.trim() ||
    policy.version.length > 128 ||
    !policy.title?.trim() ||
    policy.title.length > 256 ||
    !policy.rule?.trim() ||
    policy.rule.length > 10000 ||
    !Array.isArray(policy.scopeKinds) ||
    policy.scopeKinds.length === 0 ||
    policy.scopeKinds.some((kind) => !POLICY_SCOPE_KINDS.has(kind)) ||
    new Set(policy.scopeKinds).size !== policy.scopeKinds.length ||
    REQUIRED_POLICY_SCOPE.some((kind) => !policy.scopeKinds.includes(kind)) ||
    !["error", "critical"].includes(policy.severity) ||
    policy.enforcement !== "blocking" ||
    !protections ||
    protections.ownerApprovalRequired !== true ||
    protections.auditRetention !== "immutable" ||
    protections.verificationRequired !== true ||
    protections.rollbackRequired !== true ||
    policy.defaultEffect !== "deny" ||
    !Array.isArray(policy.rules) ||
    policy.rules.length === 0 ||
    policy.rules.length > 100 ||
    new Set(ruleIds).size !== ruleIds.length ||
    policy.rules.some((rule) =>
      !rule ||
      !POLICY_RULE_ID.test(rule.id) ||
      !POLICY_ACTIONS.has(rule.action) ||
      !["allow", "deny"].includes(rule.effect) ||
      !rule.when
    )
  ) {
    throw new PkrError(
      "PKR-EVOLUTION-010",
      "Policy must preserve owner approval, immutable audit, Verification, rollback, and protected scope",
    );
  }
  for (const rule of policy.rules) {
    evaluateExpression(rule.when, {});
  }
  const invariantProbes: Array<{
    action: string;
    context: JsonObject;
    expected: "allow" | "deny";
  }> = [
    {
      action: "pkr/promote",
      context: { ownerApproved: false, verificationPassed: true, auditRetained: true },
      expected: "deny",
    },
    {
      action: "pkr/promote",
      context: { ownerApproved: true, verificationPassed: false, auditRetained: true },
      expected: "deny",
    },
    {
      action: "pkr/promote",
      context: { ownerApproved: true, verificationPassed: true, auditRetained: false },
      expected: "deny",
    },
    {
      action: "pkr/permission-change",
      context: { ownerApproved: false },
      expected: "deny",
    },
    {
      action: "pkr/rollback",
      context: { requested: true },
      expected: "allow",
    },
  ];
  if (invariantProbes.some((probe) =>
    evaluatePolicyRules(policy, probe.action, probe.context).effect !== probe.expected
  )) {
    throw new PkrError(
      "PKR-EVOLUTION-010",
      "Policy decision table weakens a protected governance invariant",
    );
  }
}

export function evaluateGovernancePolicy(
  policy: GovernancePolicyContent,
  action: string,
  context: JsonObject,
): JsonObject {
  validateGovernancePolicy(policy);
  if (!POLICY_ACTIONS.has(action) || !context || Array.isArray(context)) {
    throw new PkrError(
      "PKR-EVOLUTION-010",
      "Policy evaluation requires a supported action and object context",
    );
  }
  const result = evaluatePolicyRules(policy, action, context);
  return {
    action,
    effect: result.effect!,
    matchedRule: result.matchedRule,
    rulesEvaluated: result.rulesEvaluated,
  };
}

export function validateEvolutionCandidate(candidate: EvolutionCandidateSpec): void {
  const canary = candidate?.canary;
  const monitoring = candidate?.monitoring;
  const monitoringThreshold = monitoring?.threshold;
  if (
    !candidate ||
    !["workflow", "prompt", "policy", "adapter", "runtime"].includes(candidate.targetKind) ||
    !candidate.targetId ||
    !candidate.activeVersion ||
    !candidate.expectedImprovement ||
    !Array.isArray(candidate.nonGoals) ||
    candidate.nonGoals.some((nonGoal) => typeof nonGoal !== "string") ||
    !candidate.permissionDelta ||
    !Array.isArray(candidate.permissionDelta.add) ||
    !Array.isArray(candidate.permissionDelta.remove) ||
    candidate.permissionDelta.add.some((permission) => typeof permission !== "string") ||
    candidate.permissionDelta.remove.some((permission) => typeof permission !== "string") ||
    !canary ||
    invalidCommonCanary(canary) ||
    !monitoring ||
    typeof monitoring.measure !== "string" ||
    !monitoring.measure.trim() ||
    monitoring.measure.length > 256 ||
    typeof monitoring.window !== "string" ||
    !monitoring.window.trim() ||
    monitoring.window.length > 256 ||
    !/^P(?!$).+/.test(monitoring.window) ||
    !Number.isInteger(monitoring.maxObservations) ||
    monitoring.maxObservations < 1 ||
    monitoring.maxObservations > 1000 ||
    monitoring.onBreach !== "require-rollback" ||
    !monitoringThreshold ||
    !["eq", "neq", "gt", "gte", "lt", "lte"].includes(monitoringThreshold.operator) ||
    !["info", "warning", "error", "critical"].includes(monitoringThreshold.severity) ||
    !["string", "number", "boolean"].includes(typeof monitoringThreshold.value) ||
    (typeof monitoringThreshold.value === "number" && !Number.isFinite(monitoringThreshold.value)) ||
    (["gt", "gte", "lt", "lte"].includes(monitoringThreshold.operator) &&
      typeof monitoringThreshold.value !== "number")
  ) {
    throw new PkrError("PKR-EVOLUTION-001", "candidate declaration or canary budget is invalid");
  }

  if (candidate.targetKind === "adapter") {
    const plan = candidate.canary as AdapterCanaryPlan;
    validateManagedAdapter(candidate.adapter!);
    const permissions = [...candidate.permissionDelta.add, ...candidate.permissionDelta.remove];
    if (
      candidate.permissionDelta.add.length !== 0 ||
      new Set(candidate.permissionDelta.remove).size !== candidate.permissionDelta.remove.length ||
      permissions.some((permission) => !ADAPTER_CAPABILITY_CEILING.has(permission)) ||
      !Number.isInteger(plan.maxPayloadBytes) ||
      plan.maxPayloadBytes < 1 ||
      plan.maxPayloadBytes > 1000000 ||
      plan.scenarios.some((scenario) =>
        !scenario ||
        !scenario.name ||
        !Array.isArray(scenario.requiredCapabilities) ||
        new Set(scenario.requiredCapabilities).size !== scenario.requiredCapabilities.length ||
        scenario.requiredCapabilities.some((capability) =>
          !ADAPTER_CAPABILITY.test(capability) || !ADAPTER_CAPABILITY_CEILING.has(capability)
        ) ||
        !scenario.callback ||
        Array.isArray(scenario.callback) ||
        typeof scenario.callback !== "object" ||
        typeof scenario.expectedAccepted !== "boolean"
      )
    ) {
      throw new PkrError(
        "PKR-EVOLUTION-012",
        "Adapter candidate cannot add capabilities and requires a bounded conformance replay",
      );
    }
    return;
  }

  if (candidate.targetKind === "policy") {
    const plan = candidate.canary as PolicyCanaryPlan;
    validateGovernancePolicy(candidate.policy!);
    if (
      candidate.permissionDelta.add.length !== 0 ||
      candidate.permissionDelta.remove.length !== 0 ||
      !Number.isInteger(plan.maxRulesEvaluated) ||
      plan.maxRulesEvaluated < 1 ||
      plan.maxRulesEvaluated > 10000 ||
      plan.scenarios.some((scenario) =>
        !scenario ||
        !scenario.name ||
        !POLICY_ACTIONS.has(scenario.action) ||
        !scenario.context ||
        Array.isArray(scenario.context) ||
        typeof scenario.context !== "object" ||
        !["allow", "deny"].includes(scenario.expectedEffect)
      )
    ) {
      throw new PkrError(
        "PKR-EVOLUTION-010",
        "Policy candidate cannot change permissions and requires a bounded decision-table replay",
      );
    }
    return;
  }

  if (candidate.targetKind === "prompt") {
    const prompt = candidate.prompt;
    const plan = candidate.canary as PromptCanaryPlan;
    const templateVariables = prompt ? promptTemplateVariables(prompt.template) : [];
    const variables = prompt?.variables ?? [];
    if (
      !prompt ||
      !prompt.version.trim() ||
      prompt.version.length > 128 ||
      !prompt.title.trim() ||
      prompt.title.length > 256 ||
      !prompt.template.trim() ||
      prompt.template.length > 10000 ||
      !Array.isArray(variables) ||
      variables.some((variable) => !PROMPT_PATH.test(variable)) ||
      new Set(variables).size !== variables.length ||
      JSON.stringify([...new Set(templateVariables)].sort()) !== JSON.stringify([...variables].sort()) ||
      !Number.isInteger(plan.maxRenderedCharacters) ||
      plan.maxRenderedCharacters < 1 ||
      plan.maxRenderedCharacters > 1000000 ||
      plan.scenarios.some((scenario) =>
        !scenario ||
        typeof scenario.name !== "string" ||
        !scenario.name ||
        !scenario.input ||
        Array.isArray(scenario.input) ||
        typeof scenario.input !== "object" ||
        !Array.isArray(scenario.requiredIncludes) ||
        scenario.requiredIncludes.length === 0 ||
        scenario.requiredIncludes.some((value) => typeof value !== "string" || !value) ||
        !Array.isArray(scenario.forbiddenIncludes) ||
        scenario.forbiddenIncludes.some((value) => typeof value !== "string" || !value)
      )
    ) {
      throw new PkrError("PKR-EVOLUTION-001", "Prompt candidate or replay plan is invalid");
    }
    return;
  }

  const plan = candidate.canary as CanaryPlan;
  if (
    !Number.isInteger(plan.maxTransitions) ||
    plan.maxTransitions < 1 ||
    plan.scenarios.some((scenario) =>
      !scenario ||
      typeof scenario.name !== "string" ||
      !Array.isArray(scenario.steps) ||
      typeof scenario.expectedFinalState !== "string" ||
      scenario.steps.some((step) =>
        !step ||
        typeof step.to !== "string" ||
        !step.context ||
        Array.isArray(step.context) ||
        typeof step.context !== "object"
      )
    )
  ) {
    throw new PkrError("PKR-EVOLUTION-001", "candidate declaration or canary budget is invalid");
  }
  if (candidate.targetKind === "workflow") {
    if (!candidate.profile || candidate.profile.packageId !== candidate.targetId) {
      throw new PkrError("PKR-EVOLUTION-001", "Workflow candidate must carry its target Profile Package");
    }
    parseWorkflowDefinition(candidate.profile.workflow as unknown as JsonObject);
  } else if (!candidate.runtimeVersion) {
    throw new PkrError("PKR-EVOLUTION-001", "Runtime candidate must declare a version");
  }
}

function promptValueAtPath(input: JsonObject, path: string): JsonValue | undefined {
  let current: JsonValue = input;
  for (const segment of path.split(".")) {
    if (current === null || Array.isArray(current) || typeof current !== "object") {
      return undefined;
    }
    current = current[segment] as JsonValue;
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

export function renderPromptTemplate(
  prompt: PromptCandidateContent,
  input: JsonObject,
): string {
  const allowed = new Set(prompt.variables);
  return prompt.template.replace(PROMPT_TOKEN, (_token, path: string) => {
    if (!allowed.has(path)) {
      throw new PkrError("PKR-EVOLUTION-008", `Prompt variable ${path} is not declared`);
    }
    const value = promptValueAtPath(input, path);
    if (value === undefined) {
      throw new PkrError("PKR-EVOLUTION-008", `Prompt input ${path} is missing`);
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

export function evaluatePromptCanary(candidate: EvolutionCandidateSpec): JsonObject {
  validateEvolutionCandidate(candidate);
  if (candidate.targetKind !== "prompt" || !candidate.prompt) {
    throw new PkrError("PKR-EVOLUTION-005", "candidate is not a Prompt evolution");
  }
  const plan = candidate.canary as PromptCanaryPlan;
  if (plan.scenarios.length > plan.maxScenarios) {
    return {
      passed: false,
      aborted: true,
      reason: "CanaryBudgetExceeded",
      scenarioCount: plan.scenarios.length,
      renderedCharacters: 0,
      successRate: 0,
      regression: plan.baselineSuccessRate,
      scenarios: [],
    };
  }

  let renderedCharacters = 0;
  const results = plan.scenarios.map((scenario) => {
    try {
      const rendered = renderPromptTemplate(candidate.prompt!, scenario.input);
      renderedCharacters += rendered.length;
      const missingRequired = scenario.requiredIncludes.filter((value) => !rendered.includes(value));
      const foundForbidden = scenario.forbiddenIncludes.filter((value) => rendered.includes(value));
      return {
        name: scenario.name,
        passed: missingRequired.length === 0 && foundForbidden.length === 0,
        renderedDigest: digest(rendered),
        renderedLength: rendered.length,
        missingRequired,
        foundForbidden,
        failure: null,
      };
    } catch (error) {
      return {
        name: scenario.name,
        passed: false,
        renderedDigest: null,
        renderedLength: 0,
        missingRequired: scenario.requiredIncludes,
        foundForbidden: [],
        failure: error instanceof Error ? error.message : "PromptRenderFailed",
      };
    }
  });
  if (renderedCharacters > plan.maxRenderedCharacters) {
    return {
      passed: false,
      aborted: true,
      reason: "CanaryBudgetExceeded",
      scenarioCount: results.length,
      renderedCharacters,
      successRate: 0,
      regression: plan.baselineSuccessRate,
      protectedOutputScope: plan.protectedOutputScope,
      scenarios: results,
    };
  }
  const passedCount = results.filter((result) => result.passed).length;
  const successRate = passedCount / results.length;
  const regression = Math.max(0, plan.baselineSuccessRate - successRate);
  const passed = successRate >= plan.requiredSuccessRate && regression <= plan.maxRegression;
  return {
    passed,
    aborted: false,
    reason: passed ? "CanaryPassed" : "CanaryThresholdFailed",
    scenarioCount: results.length,
    renderedCharacters,
    successRate,
    regression,
    requiredSuccessRate: plan.requiredSuccessRate,
    maxRegression: plan.maxRegression,
    protectedOutputScope: plan.protectedOutputScope,
    scenarios: results,
  };
}

export function evaluateAdapterCanary(candidate: EvolutionCandidateSpec): JsonObject {
  validateEvolutionCandidate(candidate);
  if (candidate.targetKind !== "adapter" || !candidate.adapter) {
    throw new PkrError("PKR-EVOLUTION-005", "candidate is not an Adapter evolution");
  }
  const plan = candidate.canary as AdapterCanaryPlan;
  const payloadBytes = Buffer.byteLength(JSON.stringify(plan.scenarios), "utf8");
  if (plan.scenarios.length > plan.maxScenarios || payloadBytes > plan.maxPayloadBytes) {
    return {
      passed: false,
      aborted: true,
      reason: "CanaryBudgetExceeded",
      adapterVersion: candidate.adapter.version,
      scenarioCount: plan.scenarios.length,
      payloadBytes,
      successRate: 0,
      regression: plan.baselineSuccessRate,
      protectedOutputScope: plan.protectedOutputScope,
      scenarios: [],
    };
  }

  const available = new Set(candidate.adapter.capabilities);
  const results = plan.scenarios.map((scenario) => {
    const missingCapabilities = scenario.requiredCapabilities.filter(
      (capability) => !available.has(capability),
    );
    const callbackFailure = adapterCallbackFailure(scenario.callback);
    const accepted = missingCapabilities.length === 0 && callbackFailure === null;
    return {
      name: scenario.name,
      passed: accepted === scenario.expectedAccepted,
      accepted,
      expectedAccepted: scenario.expectedAccepted,
      callbackOutcome: scenario.callback.outcome ?? null,
      missingCapabilities,
      callbackFailure,
    };
  });
  const passedCount = results.filter((result) => result.passed).length;
  const successRate = passedCount / results.length;
  const regression = Math.max(0, plan.baselineSuccessRate - successRate);
  const passed = successRate >= plan.requiredSuccessRate && regression <= plan.maxRegression;
  return {
    passed,
    aborted: false,
    reason: passed ? "CanaryPassed" : "CanaryThresholdFailed",
    adapterVersion: candidate.adapter.version,
    scenarioCount: results.length,
    payloadBytes,
    successRate,
    regression,
    requiredSuccessRate: plan.requiredSuccessRate,
    maxRegression: plan.maxRegression,
    protectedOutputScope: plan.protectedOutputScope,
    scenarios: results,
  };
}

export function evaluatePolicyCanary(candidate: EvolutionCandidateSpec): JsonObject {
  validateEvolutionCandidate(candidate);
  if (candidate.targetKind !== "policy" || !candidate.policy) {
    throw new PkrError("PKR-EVOLUTION-005", "candidate is not a Policy evolution");
  }
  const plan = candidate.canary as PolicyCanaryPlan;
  if (plan.scenarios.length > plan.maxScenarios) {
    return {
      passed: false,
      aborted: true,
      reason: "CanaryBudgetExceeded",
      policyVersion: candidate.policy.version,
      scenarioCount: plan.scenarios.length,
      evaluatedScenarioCount: 0,
      rulesEvaluated: 0,
      successRate: 0,
      regression: plan.baselineSuccessRate,
      protectedOutputScope: plan.protectedOutputScope,
      scenarios: [],
    };
  }

  let rulesEvaluated = 0;
  const results: JsonObject[] = [];
  for (const scenario of plan.scenarios) {
    const evaluation = evaluatePolicyRules(
      candidate.policy,
      scenario.action,
      scenario.context,
      plan.maxRulesEvaluated - rulesEvaluated,
    );
    rulesEvaluated += evaluation.rulesEvaluated;
    if (evaluation.aborted) {
      results.push({
        name: scenario.name,
        action: scenario.action,
        passed: false,
        effect: null,
        expectedEffect: scenario.expectedEffect,
        matchedRule: null,
        rulesEvaluated: evaluation.rulesEvaluated,
        failure: "CanaryBudgetExceeded",
      });
      return {
        passed: false,
        aborted: true,
        reason: "CanaryBudgetExceeded",
        policyVersion: candidate.policy.version,
        scenarioCount: plan.scenarios.length,
        evaluatedScenarioCount: results.length,
        rulesEvaluated,
        successRate: 0,
        regression: plan.baselineSuccessRate,
        protectedOutputScope: plan.protectedOutputScope,
        scenarios: results,
      };
    }
    const passed = evaluation.effect === scenario.expectedEffect;
    results.push({
      name: scenario.name,
      action: scenario.action,
      passed,
      effect: evaluation.effect!,
      expectedEffect: scenario.expectedEffect,
      matchedRule: evaluation.matchedRule,
      rulesEvaluated: evaluation.rulesEvaluated,
      failure: passed ? null : "UnexpectedPolicyEffect",
    });
  }

  const passedCount = results.filter((result) => result.passed === true).length;
  const successRate = passedCount / results.length;
  const regression = Math.max(0, plan.baselineSuccessRate - successRate);
  const passed = successRate >= plan.requiredSuccessRate && regression <= plan.maxRegression;
  return {
    passed,
    aborted: false,
    reason: passed ? "CanaryPassed" : "CanaryThresholdFailed",
    policyVersion: candidate.policy.version,
    scenarioCount: results.length,
    evaluatedScenarioCount: results.length,
    rulesEvaluated,
    successRate,
    regression,
    requiredSuccessRate: plan.requiredSuccessRate,
    maxRegression: plan.maxRegression,
    protectedOutputScope: plan.protectedOutputScope,
    scenarios: results,
  };
}

export function validateExternalSupervisorResult(
  candidate: EvolutionCandidateSpec,
  supervisorId: string,
  result: JsonObject,
): boolean {
  validateEvolutionCandidate(candidate);
  if (candidate.targetKind !== "runtime") {
    throw new PkrError(
      "PKR-EVOLUTION-006",
      "external supervisor evaluation is reserved for Runtime candidates",
    );
  }
  const plan = candidate.canary as CanaryPlan;
  const protectedScope = result.protectedOutputScope;
  const sameProtectedScope = Array.isArray(protectedScope) &&
    JSON.stringify([...protectedScope].sort()) ===
      JSON.stringify([...plan.protectedOutputScope].sort());
  if (
    !supervisorId ||
    result.adapter !== "pkr.external-supervisor/v1" ||
    result.supervisorId !== supervisorId ||
    typeof result.candidateDigest !== "string" ||
    result.runtimeVersion !== candidate.runtimeVersion ||
    typeof result.passed !== "boolean" ||
    typeof result.reason !== "string" ||
    typeof result.rollbackTested !== "boolean" ||
    typeof result.atomicSwitchReady !== "boolean" ||
    !Number.isInteger(result.scenarioCount) ||
    (result.scenarioCount as number) < 1 ||
    (result.scenarioCount as number) > plan.maxScenarios ||
    !Number.isInteger(result.transitionCount) ||
    (result.transitionCount as number) < 0 ||
    (result.transitionCount as number) > plan.maxTransitions ||
    !Number.isFinite(result.successRate) ||
    (result.successRate as number) < 0 ||
    (result.successRate as number) > 1 ||
    !Number.isFinite(result.regression) ||
    (result.regression as number) < 0 ||
    !Array.isArray(protectedScope) ||
    protectedScope.some((scope) => typeof scope !== "string" || !scope) ||
    !sameProtectedScope
  ) {
    throw new PkrError(
      "PKR-EVOLUTION-006",
      "external supervisor result is incomplete or exceeds the declared canary boundary",
    );
  }
  const qualifies =
    (result.successRate as number) >= plan.requiredSuccessRate &&
    (result.regression as number) <= plan.maxRegression &&
    result.rollbackTested === true &&
    result.atomicSwitchReady === true;
  if (result.passed !== qualifies) {
    throw new PkrError(
      "PKR-EVOLUTION-006",
      "external supervisor verdict conflicts with the declared success and rollback gates",
    );
  }
  return qualifies;
}

export function evaluateWorkflowCanary(candidate: EvolutionCandidateSpec): JsonObject {
  validateEvolutionCandidate(candidate);
  if (candidate.targetKind !== "workflow" || !candidate.profile) {
    throw new PkrError(
      "PKR-EVOLUTION-005",
      "candidate is not a Workflow evolution",
    );
  }
  const plan = candidate.canary as CanaryPlan;
  const definition = parseWorkflowDefinition(candidate.profile.workflow as unknown as JsonObject);
  const transitionCount = plan.scenarios.reduce((total, scenario) => total + scenario.steps.length, 0);
  if (plan.scenarios.length > plan.maxScenarios || transitionCount > plan.maxTransitions) {
    return {
      passed: false,
      aborted: true,
      reason: "CanaryBudgetExceeded",
      scenarioCount: plan.scenarios.length,
      transitionCount,
      successRate: 0,
      regression: plan.baselineSuccessRate,
      scenarios: [],
    };
  }

  const results = plan.scenarios.map((scenario) => {
    let state = definition.initial;
    let failure: string | null = null;
    for (const step of scenario.steps) {
      const edge = definition.transitions.find(
        (transition) => transition.from === state && transition.to === step.to,
      );
      if (!edge || !evaluateExpression(edge.when, step.context)) {
        failure = `Rejected:${state}->${step.to}`;
        break;
      }
      state = step.to;
    }
    const passed = failure === null && state === scenario.expectedFinalState;
    return {
      name: scenario.name,
      passed,
      finalState: state,
      expectedFinalState: scenario.expectedFinalState,
      failure,
    };
  });
  const passedCount = results.filter((result) => result.passed).length;
  const successRate = passedCount / results.length;
  const regression = Math.max(0, plan.baselineSuccessRate - successRate);
  return {
    passed: successRate >= plan.requiredSuccessRate && regression <= plan.maxRegression,
    aborted: false,
    reason:
      successRate >= plan.requiredSuccessRate && regression <= plan.maxRegression
        ? "CanaryPassed"
        : "CanaryThresholdFailed",
    scenarioCount: results.length,
    transitionCount,
    successRate,
    regression,
    requiredSuccessRate: plan.requiredSuccessRate,
    maxRegression: plan.maxRegression,
    protectedOutputScope: plan.protectedOutputScope,
    scenarios: results,
  };
}
