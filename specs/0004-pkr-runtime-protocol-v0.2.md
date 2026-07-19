# PKR Runtime Protocol v0.2

- Status: Draft
- Scope: Logical Runtime API, mutation commands, events, and command results
- Depends on: [PKR Object Model v0.2](0001-pkr-object-model-v0.2.md)
- Reuses: [PKR Core Schema v0.2](0002-pkr-core-schema-v0.2.md)
- Bootstrap exception: [PKR Manifest and Bootstrap v0.2](0003-pkr-manifest-bootstrap-v0.2.md)
- Normative schema: [`pkr-runtime.schema.json`](../schemas/v0.2/pkr-runtime.schema.json)

## 1. Purpose

This RFC defines the transport-neutral protocol by which authenticated
principals read project state, submit governed mutations, receive results, and
consume immutable events.

It defines logical operations and record schemas. It does not prescribe HTTP,
JSON-RPC, gRPC, message queues, local process calls, storage engines, or
deployment topology.

## 2. Protocol records are not POM objects

`RuntimeCommand`, `RuntimeEvent`, and `CommandResult` are protocol records.
They are not additional POM core objects and do not participate in the Mission
to Release lifecycle.

Commands express requested intent. Events record committed facts. Results
report protocol outcomes. Committed POM objects and Runtime control records
constitute authoritative project state. Compatible later RFCs may introduce
additional control records, such as WorkflowRun or AgentSession, without adding
POM core object kinds; their mutations remain attributable and event-producing.

## 3. Logical Runtime API

A conforming Runtime exposes these logical operations:

| Operation | Purpose | Mutation |
| --- | --- | --- |
| `submit(command)` | Validate and attempt one governed mutation | yes |
| `getObject(projectId, target, selector)` | Read one object revision | no |
| `listObjects(projectId, query)` | Read a bounded object collection | no |
| `readEvents(projectId, afterSequence, limit)` | Read ordered committed events | no |
| `getManifest(projectId, selector)` | Read Project control state | no |
| `getWorkspace(projectId, principal, assignment)` | Build a bounded Workspace projection | no |

`selector` is either the latest committed state or an explicitly supported
revision/event sequence. A Runtime MUST declare whether historical reads are
available. It MUST NOT silently return latest state for an unsupported
historical selector.

Query and Workspace request schemas are deferred. This RFC fixes their
consistency semantics but does not freeze a filter language.

## 4. Runtime command envelope

Every post-bootstrap mutation is submitted as `RuntimeCommand` and contains:

- `apiVersion`: exactly `pkr.dev/v0.2`;
- `kind`: exactly `RuntimeCommand`;
- `commandId`: globally stable idempotency key;
- `projectId`: target Project;
- `actor`: authenticated human or Agent principal;
- `roleId`: active project Role used for authorization;
- `workflow`: exact active Workflow ID and revision;
- `scope`: Task or explicit governance scope;
- `action`: one core mutation action;
- `target`: core object or Manifest control target;
- `expectedRevision`: optimistic concurrency precondition;
- `decisionBasis`: accepted Decision reference or operational reason;
- `issuedAt`: UTC timestamp;
- action-specific `payload`.

The Runtime authenticates the actor out of band. Actor identity in the JSON
document is a claim to verify, not proof.

### 4.1 Command target

A core target contains POM `kind` and object `id`. Manifest updates use
`kind: ProjectManifest` with the Project ID as target ID.

Create commands use `expectedRevision: 0`. All other mutation commands require
the currently observed positive revision. Cross-field agreement between
target, payload, and stored object is a semantic check.

### 4.2 Scope

A Task scope identifies the Task authorizing delivery work. A governance scope
uses a namespaced stable name such as `project/policy` or `project/manifest`.

Governance scope does not remove Role or Workflow requirements. It only avoids
fabricating a Task for project-level administration.

### 4.3 Decision basis

Post-bootstrap commands support exactly two bases:

- `decision`: reference to an accepted Decision object;
- `operational`: non-empty reason for reversible task-local work already
  authorized by Workflow.

`genesis` is forbidden in RuntimeCommand and remains exclusive to
`pkr/bootstrap`.

## 5. Core mutation actions

### 5.1 `createObject`

Creates one POM object from an Object Intent. Intent includes kind, ID, name,
title, spec, initial relations, and namespaced extensions. It excludes
`projectId`, revision, timestamps, createdBy, status, and events because the
Runtime owns those fields.

The Runtime materializes revision 1 in the kind's initial phase and emits
`pkr.object.created`.

### 5.2 `replaceObject`

Replaces the desired object intent at the expected revision. The target object
identity and immutable metadata remain unchanged. Runtime-observed status is
not replaced by client input.

Partial patch semantics are intentionally excluded from v0.2. Full replacement
makes validation, auditing, retry, and deterministic comparison unambiguous.

### 5.3 `addRelation` and `removeRelation`

Mutate one relation on the source target. The Runtime validates relation
vocabulary, target existence, source-target compatibility, required-link
rules, project identity, cardinality, and cycles before commit.

Removing a required relation fails unless the same atomic command model later
supports a valid replacement. Multi-command transactions are deferred, so v0.2
clients replace required relations through a governed object replacement.

### 5.4 `transitionObject`

Requests one canonical phase for the target kind. The schema constrains phase
vocabulary by target kind. The Runtime validates the edge from current phase,
Workflow authority, Constraints, required evidence, and transition guards.

Transition payload contains a stable reason code and optional human message.

### 5.5 `updateManifest`

Replaces the mutable Manifest control record under governance scope. Immutable
identity and genesis fields must match stored state. Bootstrap records cannot
be created or replaced through this action.

## 6. Command processing lifecycle

```text
received
  -> authenticated
  -> structurallyValidated
  -> authorized
  -> concurrencyChecked
  -> semanticallyValidated
  -> committed
  -> resultReturned

Any pre-commit failure -> rejected or conflict
```

Only `committed` changes project truth. Validation and authorization stages
MUST NOT mutate project objects or append project events.

### 6.1 Required evaluation order

A Runtime MUST evaluate enough information to return the most specific safe
error without leaking protected project data. The normative dependency order
is:

1. recognize API version and record kind;
2. authenticate actor;
3. validate command structure;
4. resolve Project, Role, Workflow, and scope;
5. deduplicate `commandId`;
6. compare `expectedRevision`;
7. enforce permissions, Constraints, Workflow, and decision basis;
8. validate action semantics and resulting state;
9. atomically commit object/control state and events;
10. return CommandResult.

Authentication failure may be returned before structural detail when policy
requires it.

## 7. Idempotency and optimistic concurrency

`commandId` is the idempotency key.

- Same `commandId` and equivalent command content returns the original result.
- Same `commandId` with different content returns
  `PKR-RUNTIME-006 CommandIdReuse`.
- A stale `expectedRevision` returns `conflict` and commits no event.
- A concurrent winner may advance the revision between validation and commit;
  the final compare-and-commit MUST still reject the loser.
- Replaying a committed command MUST NOT append events or advance revisions.

Equivalent content means equality of the decoded JSON data model with object
member order ignored. Cryptographic canonicalization remains deferred.

## 8. Runtime events

Every committed command emits one or more `RuntimeEvent` records in the same
atomic commit as the state mutation.

An event contains:

- project-unique `eventId` and strictly increasing `sequence`;
- stable event `type`;
- subject target and resulting `subjectRevision`;
- causing `commandId`;
- actor, Role, Workflow, scope, and decision basis;
- UTC `occurredAt`;
- event-specific immutable `data`.

Events are append-only. A Runtime MUST NOT edit, reorder, delete, or reuse an
event sequence. Rebuild from events MUST be deterministic for state governed
by this protocol.

Events from one committed command occupy a contiguous sequence range. No event
from another command may interleave.

Rejected, unauthorized, malformed, and conflicting commands do not emit
project RuntimeEvents. A host MAY record them in a separate security audit.

## 9. Command results

`CommandResult.status` is one of:

- `committed`: state and events committed;
- `rejected`: authentication, schema, authorization, policy, or semantic
  failure;
- `conflict`: optimistic concurrency or identity reservation conflict.

A committed result requires target revision and event range, with no errors.
A rejected or conflict result requires at least one error and has no committed
event range.

Returning a result is not the commit boundary. If the response is lost after
commit, retry by `commandId` returns the original result.

## 10. Runtime errors

Protocol errors contain stable `code`, human-readable `message`, optional JSON
Pointer `path`, and optional non-sensitive `details`.

| Code | Meaning |
| --- | --- |
| `PKR-RUNTIME-001` | Unsupported API version or record kind |
| `PKR-RUNTIME-002` | Authentication failed |
| `PKR-RUNTIME-003` | Structural schema validation failed |
| `PKR-RUNTIME-004` | Role, Workflow, or scope authorization failed |
| `PKR-RUNTIME-005` | Expected revision conflict |
| `PKR-RUNTIME-006` | Command ID reused with different content |
| `PKR-RUNTIME-007` | Target or relation object not found |
| `PKR-RUNTIME-008` | POM relation or lifecycle invariant failed |
| `PKR-RUNTIME-009` | Constraint or verification gate blocked mutation |
| `PKR-RUNTIME-010` | Decision basis is missing, invalid, or insufficient |
| `PKR-RUNTIME-011` | Atomic commit failed without changing project truth |
| `PKR-RUNTIME-012` | Requested historical read is unsupported or unavailable |

Existing `PKR-POM-*`, `PKR-SCHEMA-VALIDATION`, and `PKR-BOOTSTRAP-*` codes MAY
appear as nested causes but do not replace the protocol-level classification.

## 11. Read consistency

`getObject`, `listObjects`, `getManifest`, and `getWorkspace` return a
`projectSequence` identifying the latest event included in the projection.

A paginated list MUST bind all pages to one snapshot sequence or explicitly
fail when the snapshot is no longer available. It MUST NOT silently combine
objects from different project sequences.

`readEvents(afterSequence, limit)` returns a contiguous ascending range or a
declared retention gap. An empty response states the latest known sequence.

Workspace remains derived. A command created from a Workspace uses object and
Workflow revisions from that projection; stale revisions produce conflict.

## 12. Security boundaries

- Protocol records never carry authentication secrets.
- Error details MUST NOT reveal objects the actor cannot read.
- Actor permissions are evaluated against the exact Role and Workflow
  revisions in the command.
- A suspended Agent or retired Role cannot authorize a new command.
- Operational reasons cannot authorize material changes that require Decision.
- Extensions are data only unless an installed Package explicitly validates
  and interprets them.

## 13. Conformance

Structural conformance fixtures MUST cover:

- every mutation action;
- Object Intent discrimination across all fourteen core kinds;
- kind-specific transition phases;
- Task and governance scopes;
- Decision and operational bases;
- RuntimeEvent;
- committed, rejected, and conflict CommandResults;
- strict-field rejection, forbidden genesis basis, and conditional result
  fields.

Runtime semantic conformance MUST additionally prove idempotency, stale-write
rejection, authorization, graph and lifecycle invariants, atomic event ranges,
read snapshot consistency, and absence of events for rejected commands.

## 14. Deferred work

This RFC intentionally defers:

- concrete HTTP, JSON-RPC, gRPC, CLI, and in-process bindings;
- authentication credentials, signatures, and key distribution;
- query/filter and Workspace request schemas;
- batch and multi-object transactions;
- partial patch operations;
- event retention, snapshots, and compaction;
- subscriptions, webhooks, and delivery acknowledgements;
- canonical JSON signing and event hash chains;
- cross-project commands and federated reads.

The [Workflow and Verification Profile v0.3](0006-pkr-workflow-verification-v0.3.md),
[Agent Session Protocol v0.3](0007-pkr-agent-session-protocol-v0.3.md), and
[Package and Governed Evolution v0.3](0009-pkr-package-evolution-v0.3.md)
define compatible logical control records and operations. Their
machine-readable command, event, result, and read schemas remain deferred to
the v0.4 protocol schema milestone.

Transport bindings may add framing metadata but MUST preserve the command,
event, result, idempotency, ordering, and atomicity semantics defined here.
