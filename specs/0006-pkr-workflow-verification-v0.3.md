# PKR Workflow and Verification Profile v0.3

- Status: Draft
- Index: [PKR specification index](README.md)
- Scope: Portable custom state machines, transition policy, and evidence gates
- Depends on: [PKR Object Model v0.2](0001-pkr-object-model-v0.2.md)
- Reuses: [PKR Core Schema v0.2](0002-pkr-core-schema-v0.2.md)
- Runtime commands: [PKR Runtime Protocol v0.2](0004-pkr-runtime-protocol-v0.2.md)

## 1. Purpose

This RFC defines a deterministic portable profile for expressing how governed
work proceeds and how completion evidence is evaluated. It enables a Project or
Package to define custom execution states without changing core object
lifecycles or executing arbitrary code inside the Runtime policy evaluator.

## 2. Workflow definition

The existing Workflow POM object remains the authoritative policy definition.
Its `spec` contains or references a versioned definition with:

- `appliesTo`: target kinds or selectors;
- `states`: portable workflow-local state names;
- `initialState`: exactly one declared state;
- `terminalStates`: zero or more successful or unsuccessful terminal states;
- `steps`: work, tool, approval, verification, and transition steps;
- `transitions`: allowed workflow-local edges and their guards;
- `permissions`: Roles allowed to perform each action;
- `verificationPolicies`: named gate sets;
- `timeouts` and `retryPolicies` where applicable;
- `owners` and exact definition version.

Workflow-local states MUST be namespaced or scoped to the Workflow definition.
They do not replace canonical POM phases such as Task `inProgress` or `done`.

## 3. WorkflowRun control record

One execution of a Workflow is represented by a `WorkflowRun` Runtime control
record, not a fifteenth POM object kind. It contains:

```yaml
runId: run_01J...
projectId: project_01J...
workflowId: workflow_01J...
workflowRevision: 12
scope:
  type: task
  taskId: task_01J...
state: implementing
revision: 8
projectSequence: 1842
activeSteps: [implement]
completedSteps: [plan]
pendingGates: [test, acceptance]
createdBy: agent_01J...
updatedAt: 2026-07-17T12:00:00Z
```

The Runtime owns `state`, revision, active and completed step sets, pending gate
results, and timestamps. Clients request transitions through governed commands.
Every committed run mutation emits an immutable Runtime event.

### 3.1 Logical Runtime operations

The portable profile adds these logical operations:

| Operation | Purpose | Mutation |
| --- | --- | --- |
| `startWorkflowRun(definition, scope)` | Create one run at its initial state | yes |
| `transitionWorkflowRun(run, expectedRevision, transition)` | Evaluate and commit one declared edge | yes |
| `recordVerificationAttempt(run, gate, attempt)` | Validate and append one immutable attempt | yes |
| `getWorkflowRun(projectId, runId, selector)` | Read one run revision | no |
| `listWorkflowRuns(projectId, query)` | Read a sequence-bound run collection | no |

Mutations use the attribution, Role, Workflow, scope, decision basis,
idempotency, optimistic concurrency, result, and event semantics of the Runtime
Protocol. Machine-readable action envelopes are deferred to v0.4.

## 4. Portable expression profile

Guards are declarative expression trees. The portable profile supports:

- literals: string, number, boolean, and null;
- paths into the sequence-bound evaluation context;
- `all`, `any`, and `not`;
- `equals`, `notEquals`, `in`, `contains`, and `exists`;
- numeric `lessThan`, `lessThanOrEqual`, `greaterThan`, and
  `greaterThanOrEqual`;
- explicit calls to spec-defined pure predicates such as `hasPermission`,
  `gatePassed`, `hasActiveBlocker`, and `relationExists`.

Expressions MUST be deterministic for the same Project sequence and input
record revisions. The portable profile forbids:

- arbitrary source code or dynamic evaluation;
- filesystem, network, clock, environment, or random access;
- mutation from a predicate;
- unbounded loops or recursion;
- provider-specific model calls inside policy evaluation.

Packages MAY add namespaced pure predicates. A Runtime MUST reject an unknown
predicate or unsupported version rather than assume a value.

## 5. Transition definition

A transition declares:

```yaml
name: submit-for-verification
from: implementing
to: verifying
action: workflow.transition
allowedRoles: [role_developer]
guards:
  all:
    - predicate: deliverablesAvailable
    - predicate: noActiveBlocker
requiredGates: []
reasonCodes: [ImplementationComplete]
```

Transition evaluation order is:

1. authenticate the actor;
2. resolve the exact Workflow and WorkflowRun revisions;
3. validate the requested edge and reason code;
4. authorize the Role and scope;
5. build one sequence-bound evaluation context;
6. evaluate guards and active Constraints;
7. evaluate gates required before the target state;
8. atomically commit run state and events;
9. request any related POM phase transition as a separately validated mutation.

A Workflow transition MUST NOT imply that a POM transition succeeded. When both
must change together, a later transaction specification must define atomic
multi-record behavior; until then the Workflow must use an intermediate state
that makes partial completion explicit.

## 6. Step model

Portable step types are:

- `human`: requires an authenticated human action;
- `agent`: produces an Assignment under the Agent Session Protocol;
- `tool`: invokes a declared adapter capability and records its result;
- `approval`: records approval by an authorized principal;
- `verification`: creates or executes a Verification attempt;
- `transition`: requests a WorkflowRun or POM transition.

Each step declares inputs, expected outputs, allowed Roles, timeout policy,
retry policy, and completion condition. Inputs are references or projections,
not mutable embedded copies of authoritative objects.

## 7. Verification policy

A named Verification policy declares:

- target selector and applicable revision semantics;
- one or more gates from the core classes `build`, `test`, `security`,
  `performance`, `business`, and `acceptance`;
- whether each gate is required and waivable;
- evidence requirements and freshness window;
- allowed executor Roles or adapter capabilities;
- retry policy and pass aggregation rule;
- the action or transition blocked by failure or missing evidence.

Absence of a gate is a policy choice only when the policy explicitly omits it.
Absence of a result never means pass.

## 8. Evidence adapters

An evidence adapter translates a tool result into a proposed Verification
attempt. Its declaration includes:

- namespaced adapter ID and version;
- supported gate classes and methods;
- required tool capability and execution environment;
- input and output schema identifiers;
- Artifact digest and provenance behavior;
- timeout, cancellation, and redaction behavior.

Adapters do not decide final Task completion. The Runtime validates the attempt,
target revision, executor authority, evidence Artifact, method version, and
policy before committing the Verification result.

## 9. Attempts, retries, and waivers

Every attempt is immutable and records:

- target ID and revision;
- policy, gate, method, and adapter versions;
- start and finish times;
- executor principal and environment identity;
- result and stable reason code;
- immutable evidence Artifact references;
- correlation to the Assignment or command that requested it.

A retry creates a new attempt. The latest applicable attempt is determined by
target revision, policy version, gate, and declared freshness rules, not merely
wall-clock order.

A waiver must satisfy the v0.2 Object Model and additionally name the exact
blocked action it permits. It cannot authorize unrelated actions or survive its
expiry.

## 10. Progressive assurance

Workflow policy MAY distinguish reversible delivery progress from an
irreversible protected action. A missing, timed-out, or infrastructure-failed
gate may become explicit assurance debt only when:

- the blocked action is named;
- current work is reversible and outside that block scope;
- no active Constraint makes the gate immediately non-waivable;
- an owner and retry trigger are recorded;
- the debt must be resolved before the protected action.

Assurance debt is never a passed Verification.

## 11. Core invariant protection

No Workflow, Package, predicate, adapter, or waiver may:

- add an illegal POM lifecycle edge;
- make Task `done` reachable from a phase other than `verifying`;
- omit required acceptance, Artifact, or Verification checks;
- bypass an active non-waived Constraint;
- authorize a principal beyond its active Role;
- rewrite a committed attempt or event;
- evaluate stale state as if it were current.

## 12. Conformance

A conforming implementation must prove that:

1. every WorkflowRun binds an exact active Workflow revision;
2. invalid edges, Roles, predicates, reason codes, and stale revisions fail;
3. portable expressions are deterministic and side-effect free;
4. unknown namespaced predicates fail explicitly;
5. POM and WorkflowRun transitions cannot be conflated;
6. missing evidence never evaluates as pass;
7. retries preserve failed attempts;
8. assurance debt blocks its declared protected action;
9. package policies cannot weaken core invariants.

## 13. Deferred work

Machine-readable WorkflowRun, expression, policy, attempt, and adapter schemas
are deferred to v0.4. This RFC also defers cron scheduling, distributed timers,
multi-record transactions, visual workflow notation, and arbitrary executable
extension sandboxes.
