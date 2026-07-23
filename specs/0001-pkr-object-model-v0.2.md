# PKR Object Model v0.2

- Status: Draft
- Index: [PKR specification index](README.md)
- Scope: Core object model
- Depends on: [PKR v0.1 Definition](0000-pkr-v0.1.md)
- Field schema: [PKR Core Schema v0.2](0002-pkr-core-schema-v0.2.md)
- Project bootstrap: [PKR Manifest and Bootstrap v0.2](0003-pkr-manifest-bootstrap-v0.2.md)
- Runtime protocol: [PKR Runtime Protocol v0.2](0004-pkr-runtime-protocol-v0.2.md)
- Audience: runtime implementers, package authors, tool authors, and agent
  adapter authors

## 1. Purpose

This specification defines the stable language of a PKR project: what core
objects are, how they relate, which state transitions are legal, which events
mutations produce, and which invariants a conforming runtime enforces.

It intentionally does not define a storage engine, transport, CLI, database,
scheduler, or user interface.

## 2. Normative language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**,
and **MAY** are normative requirements.

An invalid command MUST fail explicitly. A runtime MUST NOT silently repair,
infer, or bypass a violated invariant.

## 3. Foundational decisions

### 3.1 Authoritative objects and derived projections

The fourteen core object kinds are authoritative records. Workspace and Memory
are derived projections over those objects and their events. They are runtime
modules, but are not additional first-class object kinds in v0.2.

This prevents a second, stale copy of project truth from emerging inside an
agent workspace or memory cache.

### 3.2 Desired and observed state

Every object separates:

- `spec`: declared intent and policy;
- `status`: runtime-observed state;
- `relations`: typed links to other objects;
- `events`: immutable evidence stored by the runtime, not mutable embedded
  history.

Clients may request a `spec` change. Only the runtime may commit `status`
transitions after validating invariants.

### 3.3 Decision basis, not decision spam

Every mutating command MUST contain a `decisionBasis`. A basis is either:

- a reference to an accepted Decision; or
- an inline operational reason for a reversible, task-local action already
  authorized by the Task and Workflow; or
- a `genesis` reason supplied by an authenticated human to the built-in
  `pkr/bootstrap` policy while no Project exists.

A standalone Decision is REQUIRED when a change affects architecture, a public
contract, security posture, data compatibility, an active Constraint, budget,
deadline, release policy, or multiple Goals. Thus every change is explainable
without creating a formal Decision for every file save. Bootstrap is the sole
material-change exception because a Decision object cannot predate its
Project; its immutable Genesis Record preserves the reason instead.

## 4. Common object envelope

Every core object MUST use this conceptual envelope:

```yaml
apiVersion: pkr.dev/v0.2
kind: Task
metadata:
  id: task_01J...
  projectId: project_01J...
  name: implement-login-rate-limit
  title: Implement login rate limiting
  revision: 7
  createdAt: 2026-07-17T10:00:00Z
  createdBy: agent_01J...
  updatedAt: 2026-07-17T11:20:00Z
  labels:
    area: identity
spec: {}
status:
  phase: ready
  reason: ReadyForExecution
  observedRevision: 7
relations: []
extensions: {}
```

### 4.1 Metadata rules

- `id`, `projectId`, `createdAt`, and `createdBy` are immutable.
- `id` MUST be unique within the project and SHOULD be globally unique.
- `name` MUST be unique within its kind and project.
- `revision` MUST increase exactly once for each committed mutation.
- Timestamps MUST be UTC RFC 3339 values.
- Labels are selectors and MUST NOT carry lifecycle or permission semantics.

### 4.2 Status rules

`status.phase` MUST be defined for the object's kind. `reason` is a stable
machine-readable code. `observedRevision` identifies the `spec` revision
evaluated by the runtime.

### 4.3 Relation shape

```yaml
- type: contributesTo
  target:
    kind: Goal
    id: goal_01J...
  required: true
```

A relation MUST resolve inside the same project. Cross-project relations are
deferred to a later specification. Authoritative objects that have emitted
events MUST NOT be hard-deleted; a lifecycle end state or tombstone preserves
their identity and history.

## 5. Core object kinds

| Kind | Meaning | Required `spec` fields | Initial | Terminal |
| --- | --- | --- | --- | --- |
| Mission | Why the project exists and how success is judged | `outcome`, `successCriteria`, `budget`, `deadline`, `owners` | `draft` | `retired` |
| Goal | A measurable outcome contributing to a Mission | `outcome`, `measures`, `owners` | `proposed` | `achieved`, `cancelled` |
| Task | Smallest schedulable unit of governed work | `objective`, `acceptance`, `verificationPolicy`, `deliverables`, `owners` | `backlog` | `done`, `cancelled` |
| Knowledge | Reusable fact, capability, prompt, or document record | `knowledgeType`, `content`, `sources`, `owners` | `draft` | `deprecated` |
| Decision | An authoritative choice and rationale | `question`, `choice`, `reasons`, `alternatives`, `scope`, `owners` | `proposed` | `rejected`, `superseded` |
| Constraint | A rule limiting permitted behavior | `rule`, `scope`, `severity`, `enforcement`, `owners` | `proposed` | `retired` |
| Workflow | Reusable action and transition policy | `appliesTo`, `steps`, `transitions`, `owners` | `draft` | `deprecated` |
| Verification | Planned or executed proof against a target | `gate`, `method`, `requiredEvidence`, `waivable`, `owners` | `pending` | `passed`, `failed`, `waived`, `cancelled` |
| Artifact | Versioned input or output with provenance | `artifactType`, `provenance`, `owners` | `declared` | `archived` |
| Metric | A defined measurement and threshold | `measure`, `source`, `window`, `thresholds`, `owners` | `defined` | `retired` |
| Agent | A registered runtime principal | `provider`, `capabilities`, `permissions`, `owners` | `registered` | `retired` |
| Role | Named responsibility and permission policy | `responsibilities`, `permissions`, `separationRules`, `owners` | `draft` | `retired` |
| Issue | A problem, risk, defect, or feedback item | `issueType`, `summary`, `severity`, `owners` | `open` | `closed`, `cancelled` |
| Release | Governed publication of verified Artifacts | `version`, `verificationPolicy`, `owners` | `planned` | `rolledBack`, `superseded`, `cancelled` |

`owners` MUST contain at least one Agent or human principal understood by the
runtime. A human principal is an authentication identity, not a fifteenth core
project object in v0.2.

Object-to-object associations are stored once, in `relations`. A required
relation MUST NOT also be copied into `spec` as a second authoritative `*Ref`
field. References in command payloads are transient command targets, not
object state.

Knowledge is not a superclass that erases other object identities. It stores
facts, capabilities, prompts, and document records; Decisions, Constraints,
Issues, Metrics, and Artifacts remain distinct queryable core kinds.

## 6. Canonical relations

| Relation | Valid source -> target | Meaning |
| --- | --- | --- |
| `contributesTo` | Goal -> Mission, Task -> Goal | Outcome hierarchy |
| `governedBy` | Task/Release -> Workflow | Permitted execution policy |
| `constrainedBy` | any core object -> Constraint | Applicable rule |
| `informedBy` | Goal/Task/Decision/Issue -> Knowledge/Metric/Issue | Evidence or context |
| `decidedBy` | Goal/Task/Constraint/Workflow/Release -> Decision | Accepted decision basis |
| `assignedTo` | Task/Issue -> Agent | Accountable executor |
| `actsAs` | Agent -> Role | Active role binding |
| `produces` | Task/Verification/Release -> Artifact | Provenanced output |
| `verifies` | Verification -> Goal/Task/Artifact/Constraint/Release | Primary target |
| `blocks` | Issue/Constraint/Task -> Goal/Task/Release | Execution blocker |
| `includes` | Release -> Task/Artifact | Release content |
| `supersedes` | Decision/Knowledge/Constraint/Artifact/Release -> same kind | Authoritative replacement |
| `derivedFrom` | Knowledge/Artifact/Metric -> Knowledge/Artifact/Metric | Provenance lineage |

Package relations MUST be namespaced, for example `pkr.game-mmo/awardsTo`, and
MUST declare source and target kinds.

### 6.1 Graph invariants

- `contributesTo` and `supersedes` MUST NOT form cycles.
- A project MUST have at most one active Mission. Any mutating Task command
  requires exactly one active Mission.
- A Goal MUST contribute to exactly one active or historical Mission.
- A Task MUST contribute to exactly one Goal.
- A Task MUST be governed by exactly one Workflow revision while executing.
- A Verification MUST verify exactly one primary target.
- A Release MUST include at least one Artifact before `verifying`.

## 7. Task association rules

A Task does not directly link every stage in the project lifecycle. Mandatory
links are deliberately minimal:

| Association | Requirement |
| --- | --- |
| Mission | REQUIRED indirectly through the Task's Goal |
| Goal | REQUIRED directly and exactly once |
| Workflow | REQUIRED directly and exactly once before `ready` |
| Role | REQUIRED via assigned Agent or allowed executor Role before `inProgress` |
| Constraint | REQUIRED when selected or inherited by scope |
| Decision | Conditional; REQUIRED for material changes in section 3.3 |
| Verification | Policy REQUIRED before `ready`; passed results REQUIRED before `done` |
| Artifact | REQUIRED when the Task declares a deliverable |
| Release | Optional; work may complete before release planning exists |

Requiring Decision and Release links on every Task would create false records.
Traceability remains through Goal, Workflow, decision basis, events, and
verification.

## 8. Lifecycles

Only listed transitions are legal. A UI MAY expose aliases, but the runtime
MUST persist canonical phases.

### 8.1 Primary lifecycle paths

```text
Mission: draft -> active -> achieved -> retired
                         \-----------> retired

Goal: proposed -> active <-> blocked -> achieved
         \          \---------------> cancelled
          \--------------------------> cancelled

Task: backlog -> ready -> inProgress <-> blocked -> verifying -> done
        \         \          \             \          \
         \---------\----------\-------------\----------> cancelled

Decision: proposed -> accepted -> superseded
              \----> rejected

Verification: pending -> running -> passed
                            \---> failed
              \---------------> waived/cancelled

Release: planned -> assembling -> verifying -> released -> superseded
             \          \           \           \------> rolledBack
              \----------\-----------\-----------------> cancelled
```

A Goal becomes `achieved` only when required Goal Verifications passed and its
measures satisfy the declared success rule.

`verifying -> inProgress` is REQUIRED after failed Task verification when more
implementation is permitted. `done` is reachable only from `verifying`.

An accepted Decision is immutable except for status, links, and annotations. A
changed choice or reason requires a new Decision that supersedes it.

An Artifact may be created in `declared` before its content exists. Transition
to `available` requires a resolvable `locator`, content `digest`, complete
provenance, and an authorized producer.

A Verification retry creates a new attempt record or object and MUST NOT
overwrite failed evidence. Released Releases and Artifact digests are
immutable.

### 8.2 Remaining lifecycle paths

| Kind | Canonical transitions |
| --- | --- |
| Knowledge | `draft -> active -> deprecated` |
| Constraint | `proposed -> active -> waived/retired`; `waived -> active/retired` |
| Workflow | `draft -> active -> deprecated` |
| Artifact | `declared -> available -> invalidated/archived`; `invalidated -> archived` |
| Metric | `defined -> collecting -> healthy/breached -> retired`; `healthy <-> breached` |
| Agent | `registered -> active -> suspended/retired`; `suspended -> active/retired` |
| Role | `draft -> active -> retired` |
| Issue | `open -> triaged -> inProgress -> resolved -> closed`; `resolved -> inProgress` reopens; active phases may become `cancelled` |

## 9. Completion and verification

### 9.1 Task `done` invariant

A runtime MUST reject transition to `done` unless all conditions are true:

1. the Task is currently `verifying`;
2. every acceptance criterion has a machine-readable `satisfied` result;
3. every deliverable resolves to an `available` Artifact with digest and
   provenance;
4. every required gate has a latest applicable result of `passed`, or `waived`
   when that gate is explicitly waivable;
5. no active unwaived Constraint or blocker prohibits completion;
6. the acting principal is authorized by Workflow and Role;
7. the command contains a valid decision basis.

Compilation or tests alone are sufficient only when the Task's complete
verification policy contains only those gates.

### 9.2 Gate model

Core gate classes are `build`, `test`, `security`, `performance`, `business`,
and `acceptance`. A project MAY omit a gate only by explicit policy, not by
absence of evidence.

A Constraint MAY mark a gate non-waivable. A waiver MUST identify its approver,
reason, expiry, and authorizing Decision.

Verification evidence MUST record target revision, method version, time range,
executor, result, and immutable evidence Artifact references.

## 10. Decision validity

A Decision may enter `accepted` only when:

1. `question` states the choice;
2. `choice` is non-empty and actionable;
3. `reasons` contains at least one reason;
4. `alternatives` is present; an empty list has an explanation;
5. `scope` identifies affected objects or selectors;
6. active Constraints were evaluated;
7. the accepting principal is authorized.

An accepted Decision MUST NOT be edited to rewrite history. A later choice
creates a new Decision with `supersedes`.

## 11. Release validity

A Release may enter `released` only when:

- every included Task is `done`;
- every included Artifact is `available`, immutable, and digest-addressed;
- all Release gates passed or have valid waivers;
- no included object is blocked by an active non-waived Constraint or Issue;
- an authorized release principal approves the transition;
- publication produces an immutable event and release manifest.

Rollback records a new transition and evidence. It does not delete history.

## 12. Commands and events

Objects are mutated through commands. Every accepted command produces at least
one immutable event.

### 12.1 Command envelope

```yaml
commandId: cmd_01J...
projectId: project_01J...
actor:
  principalId: agent_01J...
  roleId: role_developer
taskRef: task_01J...
workflowRef: workflow_delivery@12
action: transitionTask
expectedRevision: 7
decisionBasis:
  type: operational
  reason: All required verification results are present.
payload:
  to: done
issuedAt: 2026-07-17T11:20:00Z
```

A mutating command MUST include actor, Role, Workflow revision, expected target
revision, action, decision basis, timestamp, and either a Task or an explicit
governance scope. After initialization, governance commands MUST use the
project Governance Workflow and MUST NOT invent a placeholder Task. The first
transaction is the sole exception: it uses the immutable built-in
`pkr/bootstrap` policy defined by the Manifest and Bootstrap RFC because no
project Role or Workflow exists yet.

### 12.2 Event envelope

```yaml
eventId: evt_01J...
projectId: project_01J...
sequence: 1842
type: pkr.task.phaseChanged
subject:
  kind: Task
  id: task_01J...
subjectRevision: 8
commandId: cmd_01J...
actorId: agent_01J...
occurredAt: 2026-07-17T11:20:01Z
data:
  from: verifying
  to: done
```

Events are runtime records, not project object kinds. They MUST be append-only,
project-ordered, attributable to a command, and idempotently replayable.

Core event families include object creation/spec/relation changes, kind phase
changes, verification results and waivers, decision acceptance/supersession,
artifact availability/invalidation, agent registration/role binding, and
release/rollback.

## 13. Workspace and Memory projections

### 13.1 Workspace

A Workspace is a read model generated for one principal and assignment at a
specific project event sequence. It MUST include:

- active Mission, selected Goal and Task;
- exact Workflow revision and active Role;
- effective and inherited Constraints;
- directly related Knowledge, Decisions, Issues, Metrics, and Artifacts;
- Verification policy and current results;
- blockers and permitted next actions;
- projection sequence and expiry.

A Workspace MUST NOT become a mutation source. Commands reference authoritative
object revisions. A stale Workspace MUST cause an optimistic-concurrency
failure rather than overwrite newer state.

### 13.2 Memory

Memory is a relevance-ranked projection with provenance. Each entry MUST point
to authoritative objects, event ranges, or immutable Artifacts. Generated
summaries MUST be labeled derived and MUST NOT override sources.

Relevance affects retrieval order, never truth priority.

## 14. Package extension rules

A conforming package MAY:

- add namespaced fields under `extensions`;
- define domain schemas carried by Knowledge or Artifact objects;
- add namespaced relation types;
- provide Workflows, Roles, Constraints, gates, Metrics, and object templates;
- add validation stricter than the core.

A package MUST NOT:

- redefine a core field or weaken a core invariant;
- replace a core lifecycle phase or change its meaning;
- add an unnamespaced core object kind;
- treat package storage as a second authoritative state;
- erase historical events or provenance when uninstalled.

`Player`, `Guild`, or `Invoice` are extension schemas, not automatically new
runtime object kinds. A namespaced custom-kind mechanism is deferred until
extension schemas prove insufficient.

## 15. Core invariant catalog

| Code | Invariant |
| --- | --- |
| `PKR-POM-001` | Identity and creation metadata are immutable |
| `PKR-POM-002` | Revisions are monotonic; commands use optimistic concurrency |
| `PKR-POM-003` | Required relations resolve and hierarchies are acyclic |
| `PKR-POM-004` | Status transitions follow canonical lifecycles |
| `PKR-POM-005` | Mutations have an authorized actor and decision basis, plus either project Role/Workflow scope or the one-time built-in bootstrap policy |
| `PKR-POM-006` | A Task cannot be `done` without acceptance and required verification |
| `PKR-POM-007` | Accepted Decisions and released Releases cannot be rewritten |
| `PKR-POM-008` | Required evidence has immutable provenance and target revision |
| `PKR-POM-009` | Active non-waived Constraints cannot be bypassed |
| `PKR-POM-010` | Package extensions are namespaced and cannot weaken core rules |
| `PKR-POM-011` | Workspace and Memory are derived, sequence-bound projections |
| `PKR-POM-012` | Every accepted mutation emits an immutable attributable event |
| `PKR-POM-013` | Historical authoritative objects cannot be hard-deleted |

## 16. Conformance

A v0.2 Object Model implementation conforms only if an automated suite proves
that it:

1. validates every core envelope and required field;
2. accepts every legal transition and rejects every illegal transition;
3. enforces relation cardinality and cycle rules;
4. rejects `done` and `released` when a gate is missing, failed, or invalidly
   waived;
5. preserves immutable Decisions, Releases, evidence, and events;
6. rejects stale commands;
7. calculates effective Constraints deterministically;
8. prevents packages from weakening core validation;
9. produces bounded Workspaces without making them authoritative;
10. traces every mutation to actor and decision basis, then either Role,
    Workflow, command, and Task/governance scope, or the one-time built-in
    bootstrap policy;
11. preserves object identity and event history after logical deletion.

## 17. Deferred specifications

The field-level core schemas, project bootstrap, and Runtime mutation protocol
are defined by companion RFCs [0002](0002-pkr-core-schema-v0.2.md),
[0003](0003-pkr-manifest-bootstrap-v0.2.md), and
[0004](0004-pkr-runtime-protocol-v0.2.md). Draft v0.3 companion RFCs define the
previously deferred coordination semantics:

- [0005](0005-pkr-steward-lps-boundary-v0.3.md): Steward and LPS authority;
- [0006](0006-pkr-workflow-verification-v0.3.md): Workflow expression and
  Verification policy;
- [0007](0007-pkr-agent-session-protocol-v0.3.md): Agent handshake,
  capabilities, Assignments, Sessions, and Leases;
- [0008](0008-pkr-workspace-memory-v0.3.md): Workspace relevance, Memory
  retention, and promotion;
- [0009](0009-pkr-package-evolution-v0.3.md): Package compatibility and governed
  evolution.

Machine-readable schemas and semantic conformance for those v0.3 control and
projection records remain deferred to the v0.4 delivery milestone.

These RFCs may refine fields but MUST preserve object identities, the
authoritative-versus-derived boundary, lifecycle invariants, and completion
semantics unless this draft is explicitly superseded.
