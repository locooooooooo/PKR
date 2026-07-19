# PKR Manifest and Bootstrap v0.2

- Status: Draft
- Scope: Project identity, manifest, genesis authority, and atomic bootstrap
- Depends on: [PKR Object Model v0.2](0001-pkr-object-model-v0.2.md)
- Reuses: [PKR Core Schema v0.2](0002-pkr-core-schema-v0.2.md)
- Normative schema: [`pkr-bootstrap.schema.json`](../schemas/v0.2/pkr-bootstrap.schema.json)

## 1. Purpose

This RFC defines how a PKR Runtime moves from no project state to one valid,
authoritative project state. It specifies:

- the identity boundary of a Project;
- the Project Manifest control record;
- the external root of trust for the first mutation;
- the bootstrap request and immutable genesis record;
- the atomic bootstrap lifecycle and failure semantics;
- the minimum core objects that must exist when the project becomes active.

It does not define a CLI, storage layout, distributed consensus algorithm,
general command API, authentication protocol, or event transport.

## 2. Model decisions

### 2.1 Project is an aggregate boundary

A Project is the isolation, identity, ordering, and authority boundary that
contains PKR objects and events. It is not a fifteenth POM core object.

`projectId` identifies this boundary. Every authoritative object, command,
event, Workspace projection, and Memory projection belongs to exactly one
Project.

### 2.2 Manifest is a control record

The Project Manifest anchors project identity and active runtime bindings. It
is a versioned Runtime control record outside the POM object graph. It MUST NOT
be queried or extended as if it were a Mission, Knowledge, Artifact, or other
core object.

### 2.3 Bootstrap has a temporary root of trust

Before bootstrap there is no project Role, Workflow, Task, Mission, or event
log that can authorize the first mutation. The Runtime therefore executes one
spec-defined built-in policy named `pkr/bootstrap`.

This policy is not a hidden project Workflow object. It is immutable behavior
shipped with the conforming Runtime. Its only authority is to validate and
commit the bootstrap transaction. On successful commit, project-local
governance transfers to the newly created Owner Role and Governance Workflow.

## 3. Project identity

A project identity contains:

| Field | Rule |
| --- | --- |
| `projectId` | Immutable PKR Object ID with prefix `project` |
| `name` | Immutable project slug unique in the hosting Runtime |
| `title` | Mutable human-readable title |
| `description` | Optional mutable description |
| `createdAt` | Immutable UTC RFC 3339 timestamp |
| `createdBy` | Immutable authenticated human principal ID |

`projectId` is authoritative. Directory names, repository URLs, Git remotes,
package names, and display titles MUST NOT be used as substitute identities.

A project rename changes `title` or external aliases. It does not change
`projectId` or `name` in v0.2.

## 4. Project Manifest

The Manifest contains exactly these sections:

- `apiVersion`: `pkr.dev/v0.2`;
- `kind`: `ProjectManifest`;
- `metadata`: identity, revision, and timestamps;
- `runtime`: bound schema versions and single-Mission mode;
- `governance`: active Owner Role and Governance Workflow IDs;
- `mission`: active Mission ID;
- `genesis`: committed bootstrap transaction and event range;
- `status`: Manifest phase and observed revision;
- `extensions`: namespaced package data.

### 4.1 Runtime bindings

The v0.2 Manifest binds:

- object API version `pkr.dev/v0.2`;
- the logical Core Object Schema `$id`;
- the logical Bootstrap Schema `$id`;
- Mission mode `single`.

A runtime MUST reject an unsupported binding. It MUST NOT silently load a
different schema with the same intent.

### 4.2 Manifest lifecycle

```text
active <-> suspended -> retired
```

The Manifest is created directly as `active` by the atomic bootstrap commit.
This does not bypass a POM lifecycle because Manifest is not a POM object.

`suspended` prevents ordinary mutating commands but permits authorized
governance recovery. `retired` is terminal and preserves all project history.

### 4.3 Manifest mutation

After bootstrap, Manifest changes use the project Governance Workflow. Each
successful change increments `metadata.revision`, updates `updatedAt`, and
emits an attributable event.

`projectId`, `name`, `createdAt`, `createdBy`, and the `genesis` section are
immutable.

## 5. Genesis authority

The bootstrap request names one `authority` principal. In v0.2 this principal
MUST be human. An Agent MAY prepare a request but MUST NOT self-authorize the
creation of its own project, Role, or permissions.

The hosting Runtime MUST authenticate the human through an out-of-band trust
mechanism before evaluating the request. Merely placing a principal ID in JSON
is not proof of identity.

Authentication mechanisms such as local operating-system identity, signed
requests, organization IAM, or hardware keys are host concerns deferred from
this RFC. The semantic result is binary: authenticated or rejected.

### 5.1 Genesis decision basis

The request MUST contain a `decisionBasis` with type `genesis` and a non-empty
human reason for creating the Project. This is the only mutation basis that
does not reference a Task, project Workflow, or accepted Decision, because
none can exist before bootstrap.

The basis is valid only inside `pkr/bootstrap`, only for an authenticated human
authority, and only while the Project is absent. It is copied unchanged into
the immutable Genesis Record. It cannot authorize later project mutations.

## 6. Bootstrap request

A `ProjectBootstrapRequest` contains:

- stable `requestId` and `issuedAt`;
- explicit genesis `decisionBasis`;
- authenticated human `authority`;
- requested project identity;
- one Mission seed;
- one Owner Role seed;
- one Governance Workflow seed;
- namespaced extensions.

A seed contains `id`, `name`, `title`, and a complete core object `spec`. It
does not contain runtime-controlled metadata, status, revision, relations, or
events.

Only these three seed kinds are allowed in v0.2. Additional core objects are
created after bootstrap through the Governance Workflow. This keeps the root
transaction minimal and auditable.

### 6.1 Seed ownership

Every seed `owners` array MUST contain the authenticated authority as
`accountable`. Other owners MAY be declared, but they gain no permissions
unless authorized by the Owner Role and later governance actions.

### 6.2 Seed identity

The requested project ID, Mission ID, Role ID, and Workflow ID MUST be
distinct. Their prefixes MUST match their purpose. Seed names MUST be unique
within their kinds.

## 7. Built-in bootstrap policy

`pkr/bootstrap` performs only these actions:

1. authenticate genesis authority;
2. validate request structure against the normative schema;
3. verify the target Runtime namespace has no committed project state;
4. validate semantic seed and ownership rules;
5. acquire an exclusive project identity reservation;
6. atomically materialize Manifest, objects, events, and Genesis Record;
7. verify all postconditions;
8. expose the committed project state.

The policy MUST NOT create arbitrary objects, install packages, import a
repository, register an Agent, execute project code, or call an external
Workflow.

## 8. Atomic bootstrap lifecycle

```text
absent
  -> validating
  -> reserving
  -> materializing
  -> verifying
  -> active

Any failure before active -> absent
```

`validating`, `reserving`, `materializing`, and `verifying` are transaction
stages, not persisted Project or Manifest phases.

### 8.1 Empty-state precondition

Bootstrap may begin only when all are absent for the requested `projectId` and
host-level project `name`:

- Project Manifest;
- POM objects;
- project event sequence;
- Genesis Record;
- committed identity reservation.

Uncommitted journals, locks, or failed-attempt security logs do not constitute
project state, but the Runtime must recover or expire them before retry.

### 8.2 Atomic visibility

No Manifest, seed object, event, or Genesis Record may become externally
visible until the entire transaction passes postcondition verification.

On failure, the Runtime MUST leave no authoritative project state. It MAY
retain an out-of-band security audit of the failed attempt, clearly separated
from PKR project truth.

## 9. Materialized state

The transaction materializes core objects through legal internal transitions:

1. create Owner Role in `draft`;
2. transition Owner Role to `active`;
3. create Governance Workflow in `draft`;
4. transition Governance Workflow to `active`;
5. create Mission in `draft`;
6. transition Mission to `active`;
7. create active Project Manifest with the three object bindings;
8. create immutable Genesis Record;
9. append the terminal `pkr.project.bootstrapped` event.

All internal mutations and events commit atomically. The final core object
revisions reflect their creation and activation mutations; the bootstrap
request does not choose revisions or timestamps.

The project-local Governance Workflow becomes authoritative only after commit.
No Task is fabricated for bootstrap. Genesis operations use governance scope
`project/bootstrap` as permitted by POM invariant `PKR-POM-005`.

## 10. Genesis Record and events

`ProjectGenesisRecord` is an immutable Runtime control record, not a POM core
object. It records:

- `projectId`, `requestId`, and Runtime-generated `transactionId`;
- authenticated authority;
- immutable genesis decision basis;
- built-in policy name and version;
- commit timestamp;
- Manifest revision;
- every created core object kind, ID, and final revision;
- the contiguous committed event sequence range;
- terminal bootstrap event ID.

The committed event range MUST include, in causal order:

- `pkr.project.created`;
- Role creation and activation;
- Workflow creation and activation;
- Mission creation and activation;
- `pkr.project.bootstrapped` as the final event.

Other implementation events MAY appear inside the range, but the range MUST be
contiguous and MUST contain no events from another Project.

Object and event content digests are deferred until canonical JSON signing is
specified. Implementations MUST NOT invent incompatible digest semantics in
the Genesis Record.

## 11. Idempotency and concurrency

`requestId` is the idempotency key.

- Repeating a committed request with the same `requestId` and identical
  content returns the existing Manifest and Genesis Record.
- Reusing a committed `requestId` with different content fails.
- Retrying after an uncommitted failure may execute again.
- A different request for an existing `projectId` or project `name` fails as
  already initialized.
- Concurrent requests compete on both `projectId` and project `name`; at most
  one may commit.

Idempotent replay MUST NOT append duplicate events or increment revisions.

## 12. Bootstrap postconditions

A project may become externally visible as `active` only when all are true:

1. exactly one active Manifest exists;
2. exactly one active Mission exists and matches `mission.activeMissionId`;
3. the bound Owner Role exists and is `active`;
4. the bound Governance Workflow exists and is `active`;
5. all three objects belong to the Manifest `projectId`;
6. the authority is accountable owner of all three object specs;
7. every created object passes Core Schema validation;
8. all required bootstrap events form one contiguous project sequence;
9. the Genesis Record matches the committed request, decision basis, and final
   revisions;
10. the terminal event is `pkr.project.bootstrapped`;
11. no Task, Agent, Release, Package, or repository import was implicitly
    created.

Failure of a postcondition aborts the transaction.

## 13. Stable bootstrap errors

| Code | Meaning |
| --- | --- |
| `PKR-BOOTSTRAP-001` | Project ID or name is already initialized |
| `PKR-BOOTSTRAP-002` | Genesis authority authentication failed |
| `PKR-BOOTSTRAP-003` | Request failed structural schema validation |
| `PKR-BOOTSTRAP-004` | Seed identity, ownership, or prefix is invalid |
| `PKR-BOOTSTRAP-005` | Owner Role or Governance Workflow is insufficient |
| `PKR-BOOTSTRAP-006` | Runtime does not support a required schema binding |
| `PKR-BOOTSTRAP-007` | Identity reservation lost to a concurrent request |
| `PKR-BOOTSTRAP-008` | Request ID was reused with different content |
| `PKR-BOOTSTRAP-009` | Atomic commit failed and was rolled back |
| `PKR-BOOTSTRAP-010` | Postcondition verification failed and was rolled back |

Errors MUST identify the failed stage and MUST NOT report success when cleanup
is incomplete.

## 14. Logical filesystem projection

A filesystem Runtime MAY project the committed records as:

```text
.pkr/
|-- manifest.json
|-- genesis.json
|-- mission/
|-- roles/
|-- workflows/
`-- runtime/
    `-- events/
```

This layout is not normative. File existence alone is not proof of a committed
bootstrap; the Manifest, Genesis Record, object state, and event range must
agree.

## 15. Conformance

A conforming implementation or test harness must prove:

1. all three control record kinds pass the bootstrap JSON Schema;
2. invalid authority, missing seeds, unknown fields, invalid phases, and
   malformed extensions fail structurally;
3. non-empty state, ownership mismatch, duplicate identity, and insufficient
   governance fail semantically;
4. injected failures at every transaction stage leave no project state;
5. same-request replay is event- and revision-idempotent;
6. concurrent bootstrap permits only one commit;
7. all eleven postconditions hold after success.

The repository fixtures validate structural rules. Atomicity, concurrency,
authentication, semantic ownership, and event-order tests belong to the later
Runtime conformance harness.

## 16. Deferred work

General command and event schemas are defined by the companion
[PKR Runtime Protocol v0.2](0004-pkr-runtime-protocol-v0.2.md). This RFC still
defers:

- host authentication and signature protocols;
- canonical JSON and content signing;
- multi-Mission projects;
- project rename and identity federation;
- repository discovery or import during bootstrap;
- default packages, Agents, Tasks, Constraints, or verification policies;
- storage recovery and distributed transaction algorithms.

These capabilities MUST build on the identity and atomicity invariants here;
they must not weaken or bypass genesis authority.
