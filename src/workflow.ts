import { PkrError } from "./errors.js";
import type { JsonObject, JsonValue } from "./types.js";

export type PortableExpression =
  | { op: "eq"; path: string; value: JsonValue }
  | { op: "in"; path: string; values: JsonValue[] }
  | { op: "exists"; path: string }
  | { op: "and"; expressions: PortableExpression[] }
  | { op: "or"; expressions: PortableExpression[] }
  | { op: "not"; expression: PortableExpression };

export interface WorkflowTransitionDefinition {
  name: string;
  from: string;
  to: string;
  when: PortableExpression;
}

export interface PortableWorkflowDefinition {
  initial: string;
  terminal: string[];
  states: string[];
  transitions: WorkflowTransitionDefinition[];
  verificationPolicy: string[];
}

function valueAtPath(context: JsonObject, path: string): JsonValue | undefined {
  if (!/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*$/.test(path)) {
    throw new PkrError("PKR-WORKFLOW-001", `invalid deterministic input path ${path}`);
  }
  let current: JsonValue = context;
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

function equal(left: JsonValue | undefined, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function evaluateExpression(
  expression: PortableExpression,
  context: JsonObject,
  depth = 0,
): boolean {
  if (depth > 16) {
    throw new PkrError("PKR-WORKFLOW-001", "portable expression nesting exceeds 16");
  }
  switch (expression.op) {
    case "eq":
      return equal(valueAtPath(context, expression.path), expression.value);
    case "in": {
      const value = valueAtPath(context, expression.path);
      return expression.values.some((candidate) => equal(value, candidate));
    }
    case "exists":
      return valueAtPath(context, expression.path) !== undefined;
    case "and":
      return expression.expressions.every((item) =>
        evaluateExpression(item, context, depth + 1),
      );
    case "or":
      return expression.expressions.some((item) =>
        evaluateExpression(item, context, depth + 1),
      );
    case "not":
      return !evaluateExpression(expression.expression, context, depth + 1);
    default:
      throw new PkrError("PKR-WORKFLOW-001", "unsupported portable expression operator");
  }
}

export function parseWorkflowDefinition(value: JsonValue): PortableWorkflowDefinition {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new PkrError("PKR-WORKFLOW-001", "Workflow definition must be an object");
  }
  const definition = value as unknown as PortableWorkflowDefinition;
  if (
    typeof definition.initial !== "string" ||
    !Array.isArray(definition.terminal) ||
    !Array.isArray(definition.states) ||
    !Array.isArray(definition.transitions) ||
    !Array.isArray(definition.verificationPolicy) ||
    !definition.states.includes(definition.initial) ||
    definition.terminal.some((state) => !definition.states.includes(state))
  ) {
    throw new PkrError("PKR-WORKFLOW-001", "Workflow definition has invalid states");
  }
  const seen = new Set<string>();
  for (const state of definition.states) {
    if (!/^[a-z][A-Za-z0-9.-]*$/.test(state) || seen.has(state)) {
      throw new PkrError("PKR-WORKFLOW-001", `invalid or duplicate Workflow state ${state}`);
    }
    seen.add(state);
  }
  for (const transition of definition.transitions) {
    if (
      !transition ||
      typeof transition.name !== "string" ||
      !definition.states.includes(transition.from) ||
      !definition.states.includes(transition.to) ||
      !transition.when
    ) {
      throw new PkrError("PKR-WORKFLOW-001", "Workflow transition references an illegal edge");
    }
    evaluateExpression(transition.when, {});
  }
  return definition;
}
