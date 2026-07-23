# PKR Core Schema v0.2

- Status: Draft
- Index: [PKR specification index](README.md)
- Scope: Field-level representation of the fourteen core object kinds
- Depends on: [PKR Object Model v0.2](0001-pkr-object-model-v0.2.md)
- Normative schema: [`pkr-object.schema.json`](../schemas/v0.2/pkr-object.schema.json)

## 1. Purpose

This RFC turns the PKR Object Model into a portable data contract. It defines
the canonical JSON representation of every core object, validates all declared
fields and phases, and establishes the boundary between structural validation
and runtime semantic validation.

It does not define persistence, transport, workflow execution, graph queries,
or state-transition authorization.

## 2. Representation

### 2.1 Canonical form

The canonical interchange form is JSON conforming to JSON Schema Draft
2020-12. YAML MAY be accepted as an authoring format only when it decodes to
the same JSON data model without custom tags, anchors with observable identity,
or non-string mapping keys.

A runtime MUST validate the decoded document before storing or acting on it.

### 2.2 Required, absent, and null

- A field marked required MUST be present even when its collection is empty.
- An optional field that is unknown MUST be absent.
- `null` is forbidden unless the schema explicitly includes it.
- Empty strings MUST NOT stand in for unknown values.
- Schema `default` values are documentation only and MUST NOT be silently
  injected. The current core schema defines no defaults.

This makes absence intentional and prevents different clients from inventing
different implicit values.

### 2.3 Strict objects

Core envelopes, specs, statuses, and structured values reject unknown fields.
Extension data belongs only under the top-level `extensions` object. Each
extension key MUST be namespaced as `package/name`, for example
`pkr.game-mmo/player`.

## 3. Common scalar types

| Type | Rule |
| --- | --- |
| Object ID | `<prefix>_<stable-id>`, 5-161 characters, case-sensitive after the prefix |
| Name | 1-63 lowercase letters, digits, dots, underscores, or hyphens |
| Namespaced name | A core name or `namespace/name` |
| Reason code | 3-64 alphanumeric characters beginning with an uppercase letter |
| Timestamp | RFC 3339 `date-time` in UTC for persisted runtime output |
| Digest | `<algorithm>:<hex>`, with at least 16 hexadecimal characters |
| URI | RFC 3986 URI; Artifact locators may be URI references |

Schema validation checks timestamp format. Runtime serialization MUST
normalize persisted timestamps to UTC using the `Z` suffix.

## 4. Common envelope

Every core object contains exactly these top-level fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `apiVersion` | yes | Exactly `pkr.dev/v0.2` |
| `kind` | yes | One of the fourteen core kinds |
| `metadata` | yes | Stable identity and revision metadata |
| `spec` | yes | Desired configuration for the selected kind |
| `status` | yes | Observed phase and results for the selected kind |
| `relations` | yes | Typed links to authoritative objects |
| `extensions` | yes | Namespaced package-owned data; may be empty |

`metadata` requires `id`, `projectId`, `name`, `title`, `revision`,
`createdAt`, `createdBy`, and `updatedAt`. `labels` is optional. Identity
immutability and monotonic revisions are semantic invariants because JSON
Schema validates one document, not its history.

## 5. Principals and ownership

Every `spec` contains a non-empty `owners` array. An owner entry contains:

- `principalType`: `human` or `agent`;
- `principalId`: stable Object ID;
- `accountability`: `accountable`, `responsible`, `consulted`, or `informed`.

At least one entry MUST be `accountable`. JSON Schema enforces this local
property. The runtime semantic validator confirms Agent existence, human
identity validity, Role bindings, and permissions.

## 6. Relations

A relation requires `type`, `target`, and `required`; `slot` is optional.

`target` contains only `kind` and `id`. A relation never embeds or copies the
target object. `slot` maps a relation to a named declaration such as a Task
deliverable without placing a second object reference in `spec`.

Core relation names are fixed by the POM. Package-defined relations use
`namespace/name`. JSON Schema validates the shape and vocabulary. The runtime
validates target existence, source-target compatibility, cardinality, project
identity, required links, and cycle rules.

## 7. Desired-state fields

| Kind | Required fields beyond `owners` | Optional fields |
| --- | --- | --- |
| Mission | `outcome`, `successCriteria`, `budget`, `deadline` | none |
| Goal | `outcome`, `measures` | none |
| Task | `objective`, `acceptance`, `verificationPolicy`, `deliverables` | none |
| Knowledge | `knowledgeType`, `content`, `sources` | none |
| Decision | `question`, `choice`, `reasons`, `alternatives`, `scope` | `alternativeOmissionReason` |
| Constraint | `rule`, `scope`, `severity`, `enforcement` | none |
| Workflow | `appliesTo`, `steps`, `transitions` | none |
| Verification | `gate`, `method`, `requiredEvidence`, `waivable` | none |
| Artifact | `artifactType`, `provenance` | `locator`, `digest` |
| Metric | `measure`, `source`, `window`, `thresholds` | none |
| Agent | `provider`, `capabilities`, `permissions` | none |
| Role | `responsibilities`, `permissions`, `separationRules` | none |
| Issue | `issueType`, `summary`, `severity`, `impact` | none |
| Release | `version`, `verificationPolicy` | none |

Collections that express declared policy are present even when empty. In
particular, Task `deliverables`, Decision `alternatives`, Workflow
`transitions`, and Role `separationRules` are always explicit.

### 7.1 Mission unknown values

`budget` and `deadline` are required policy objects rather than nullable
scalars. Budget uses `fixed`, `unbounded`, or `notSet`; non-fixed values require
a reason. Deadline uses `fixed` or `none`; `none` requires a reason.

### 7.2 Criteria and measures

Mission success criteria and Task acceptance criteria have stable local IDs, a
statement, and a `required` flag. Goal measures additionally declare an
operator, target, and optional unit. The `range` operator requires
`upperTarget`.

Local IDs are stable within the owning object revision lineage. Runtime
results use these IDs instead of copying criterion text.

### 7.3 Verification policy

A verification policy contains at least one gate. Each gate declares:

- a core or namespaced gate name;
- whether the gate is required;
- whether policy permits a waiver.

`allowWaiver` does not itself authorize a waiver. POM Constraints, an accepted
Decision, and an authorized approver remain required.

### 7.4 Decision alternatives

`reasons` always contains at least one item. `alternatives` is always present.
When it is empty, `alternativeOmissionReason` becomes required. This
distinguishes a deliberate single-option decision from an incomplete record.

### 7.5 Artifact declaration

An Artifact may begin in `declared` without `locator` or `digest` because its
content may not exist yet. `provenance.declaredBy` and `sourceDigests` are
still required. When its phase is `available`, `invalidated`, or `archived`,
`locator`, `digest`, and full `provenance.generation` are required.

## 8. Observed-state fields

Every status requires:

- `phase`: a kind-specific POM phase;
- `reason`: stable machine-readable reason code;
- `observedRevision`: the evaluated spec revision.

`message` is optional diagnostic text and is never a policy input.

Kind-specific observed fields are:

| Kind | Fields |
| --- | --- |
| Goal | required `measureResults` |
| Task | required `acceptanceResults` |
| Constraint | `waiver`, required in `waived` |
| Verification | required `attempt`; execution timestamps, target revision, executor, and conditional waiver |
| Metric | optional `lastValue`, `observedAt` |
| Agent | optional `lastSeenAt` |
| Issue | `resolution`, required in `resolved` or `closed` |
| Release | `publishedAt` and `manifestDigest`, required after publication |
| Other kinds | common status fields only |

Task acceptance results and Goal measure results are local observed facts. The
runtime still resolves independent Verification objects and Artifact evidence
before allowing `done` or `achieved`.

## 9. Structural and semantic validation boundary

### 9.1 JSON Schema MUST validate

- exact top-level and nested field names;
- required and optional field presence;
- scalar types, string patterns, and timestamp/URI formats;
- core kind and phase enumerations;
- minimum collection sizes and ownership accountability;
- conditional local fields such as Decision omission reasons, waivers, Issue
  resolution, published Release evidence, and available Artifact identity;
- namespaced extension and relation names.

### 9.2 Runtime semantic validation MUST validate

- referenced object existence and same-project identity;
- legal source-target relation combinations and relation cardinality;
- acyclic `contributesTo` and `supersedes` graphs;
- uniqueness of metadata names and IDs in project state;
- metadata immutability and revision monotonicity across events;
- legal lifecycle transitions from prior observed state;
- effective inherited Constraints and waiver authority;
- Role permissions and separation of duties;
- Workflow step and transition references;
- completeness of acceptance, measure, verification, and release gates;
- digest content, evidence provenance, and Artifact availability;
- Package compatibility and extension behavior.

A document passing JSON Schema is structurally well-formed, not automatically
authorized, internally consistent with the project graph, or eligible for a
state transition.

## 10. Error contract

A structural validator SHOULD return one error per failing schema assertion
with:

- object ID when readable;
- JSON Pointer instance path;
- schema keyword;
- stable code `PKR-SCHEMA-VALIDATION`;
- human-readable message.

Runtimes MUST NOT collapse structural and semantic failures into a generic
`invalid object` error. POM semantic failures retain their `PKR-POM-*` codes.

## 11. Compatibility

- Additive optional fields require a new schema revision but may remain under
  `pkr.dev/v0.2` while this RFC is Draft.
- Adding a required field, removing a field, narrowing accepted values, or
  changing field meaning is breaking.
- Once v0.2 is declared stable, a breaking representation change requires a new
  `apiVersion`.
- Readers MUST reject unsupported `apiVersion` values rather than guessing.

Schema `$id` identifies the logical schema. Implementations SHOULD pin a
content digest as well as the `$id` when reproducibility matters.

## 12. Conformance

The repository conformance fixtures contain at least one valid object for each
core kind and targeted invalid cases for strict fields, ownership, phases,
Decision rationale, conditional Artifact fields, waivers, and Release
publication evidence.

A schema change is acceptable only when:

1. Draft 2020-12 meta-schema validation passes;
2. every valid fixture remains valid unless the RFC records a breaking change;
3. every invalid fixture fails for the intended rule;
4. all fourteen kinds remain covered;
5. the schema does not attempt to replace POM semantic validation.

## 13. Deferred work

Command and event schemas are defined by the companion
[PKR Runtime Protocol v0.2](0004-pkr-runtime-protocol-v0.2.md). Semantic drafts
for the previously deferred layers are defined by the
[Workflow and Verification Profile](0006-pkr-workflow-verification-v0.3.md),
[Agent Session Protocol](0007-pkr-agent-session-protocol-v0.3.md),
[Workspace and Memory RFC](0008-pkr-workspace-memory-v0.3.md), and
[Package and Governed Evolution RFC](0009-pkr-package-evolution-v0.3.md).
The following machine-readable work remains outside this RFC:

- WorkflowRun, policy, and evidence adapter schemas;
- Assignment, AgentSession, Lease, and AgentMessage schemas;
- Workspace and Memory projection schemas;
- PackageManifest, PackageInstallation, and custom extension schemas;
- canonical JSON serialization for signing;
- cross-project targets and federated identity;
- semantic graph validator and lifecycle conformance suite.

These schemas MUST reuse the scalar and identity rules defined here or
explicitly supersede this draft.
