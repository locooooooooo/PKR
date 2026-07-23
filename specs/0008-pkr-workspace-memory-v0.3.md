# PKR Workspace and Memory v0.3

- Status: Draft
- Index: [PKR specification index](README.md)
- Scope: Bounded task context, persistent derived memory, retention, and promotion
- Depends on: [PKR Object Model v0.2](0001-pkr-object-model-v0.2.md)
- Runtime reads: [PKR Runtime Protocol v0.2](0004-pkr-runtime-protocol-v0.2.md)
- Agent execution: [PKR Agent Session Protocol v0.3](0007-pkr-agent-session-protocol-v0.3.md)

## 1. Purpose

This RFC defines how a Runtime builds the bounded world an Agent needs and how
it persists useful derived Memory without turning summaries, relevance scores,
or conversation history into a competing source of project truth.

## 2. Authority model

Authoritative project claims live in committed POM objects, Project control
records, immutable Runtime events, and immutable Artifacts. Workspace and Memory
are sequence-bound derived projections over those sources.

A Runtime MAY persist projection indexes and generated summaries for performance
and continuity. Persisted derived data MUST remain rebuildable, provenance-bound,
and lower priority than its sources.

## 3. Workspace request

A Workspace request identifies:

- `projectId`;
- authenticated principal and active Role;
- Assignment, Task, or explicit governance scope;
- requested projection profile and maximum size;
- latest acceptable project sequence or consistency selector;
- optional capability and tool context;
- request time and idempotency key.

The Runtime authorizes the read before selecting content. A request cannot widen
the principal's object, field, Artifact, secret, or event visibility.

## 4. Workspace projection

A Workspace contains:

- projection ID, project sequence, creation time, and expiry;
- active Mission and selected Goal and Task revisions;
- exact Workflow, WorkflowRun, Role, Assignment, Session, and Lease context;
- effective Constraints and pending Decisions;
- relevant Knowledge, Issues, Metrics, and Artifact metadata;
- Verification policy, attempts, blockers, and assurance debt;
- permitted next actions and forbidden actions;
- relevant Memory entries with provenance and derivation labels;
- truncation, omission, redaction, and freshness notices.

The projection MUST distinguish:

- full authoritative records included by reference or value;
- authoritative excerpts with source pointers;
- derived summaries;
- adapter-local hints;
- unavailable or redacted content.

A Workspace is immutable after issue. A command derived from it still uses the
current Runtime protocol and exact expected object revisions.

## 5. Bounded selection

The Runtime selects content in this order:

1. mandatory execution contract: Mission, Goal, Task, Workflow, Role,
   Assignment, effective Constraints, and Verification policy;
2. directly related Decisions, blockers, Knowledge, Artifacts, and attempts;
3. dependency and provenance neighborhood required for interpretation;
4. relevance-ranked Memory and recent events within the remaining budget;
5. optional background context.

Mandatory content cannot be silently truncated. When it exceeds the declared
limit, Workspace creation fails with a stable capacity error or returns a
declared segmented projection that preserves the mandatory set.

Relevance MAY use semantic similarity, graph distance, recency, Role, workflow
step, prior utility, or explicit pinning. Relevance never changes truth priority.

## 6. Memory classes

The portable Memory projection recognizes:

- `episodic`: attributable execution or interaction episodes derived from
  events, Assignments, Sessions, and callbacks;
- `semantic`: reusable facts derived from Knowledge, Decisions, Metrics,
  Constraints, and verified Artifacts;
- `procedural`: guidance derived from active Workflows, Roles, Packages, and
  successful governed execution patterns;
- `working`: short-lived context for one Workspace or Session.

These classes describe retrieval behavior, not new authority levels. A semantic
Memory entry remains derived even when highly trusted.

## 7. Memory entry

A Memory entry contains:

```yaml
memoryId: memory_01J...
projectId: project_01J...
class: procedural
summary: Run the targeted identity tests before the full suite.
derived: true
sourceRefs:
  - kind: Workflow
    id: workflow_01J...
    revision: 12
eventRanges:
  - from: 1801
    to: 1842
createdAt: 2026-07-17T12:00:00Z
derivation:
  method: pkr.memory.summarize
  version: 1.0.0
confidence: 0.93
retentionClass: project
visibility: role:developer
validUntil: null
```

Each entry MUST identify all material sources, the event sequence used,
derivation method and version, visibility, retention class, and invalidation
conditions. Confidence is ranking metadata and cannot authorize action.

## 8. Persistence and reconstruction

A persistent Memory store is a cache or index over authoritative sources. The
Runtime MUST support:

- deterministic source resolution for every returned entry;
- invalidation when a source is superseded, redacted, deleted logically, or
  moves outside visibility;
- rebuild from retained sources and events within the declared retention model;
- detection of stale derivation versions;
- export that distinguishes source references from generated text.

If a source is no longer retained, the entry must be marked orphaned and cannot
be used for governed action. Implementations MUST NOT claim full reconstructive
guarantees beyond their declared event and Artifact retention boundary.

## 9. Promotion to project truth

When an execution pattern or generated claim should influence future governed
behavior, the Runtime or Steward creates a proposal for an appropriate POM
object:

- fact or reusable instruction -> Knowledge;
- consequential choice -> Decision;
- required limit -> Constraint;
- process change -> Workflow;
- defect, risk, or feedback -> Issue;
- measured behavior -> Metric;
- generated report or model -> Artifact.

Promotion requires source provenance, an authorized actor, a decision basis,
the applicable Workflow, and any required Verification. The new object, not the
Memory entry, becomes authoritative after commit.

## 10. Retention and forgetting

Retention classes are implementation-declared but must include logical
equivalents of:

- `session`: expires with the AgentSession;
- `task`: retained through Task closure and its configured audit period;
- `project`: retained until superseded, invalidated, or governed removal;
- `legalHold`: retained under an active Constraint or external policy.

Forgetting derived content may delete cache data when reconstruction is allowed.
Forgetting MUST NOT delete authoritative events, Artifacts, or objects contrary
to their retention and immutability rules.

Redaction creates an attributable event or host audit record, preserves the fact
that content was removed when policy requires it, and invalidates dependent
Memory entries and Workspaces.

## 11. Conversation handling

Conversation transcripts are provider or interface Artifacts unless explicitly
ingested under project policy. They are not automatically Knowledge, Decisions,
approvals, or execution evidence.

A Steward may summarize a conversation into Memory for continuity. Material
human approval must be committed through an authenticated governance action;
the summary alone is insufficient.

## 12. Isolation and security

- Retrieval enforces current permissions, not the permissions present when an
  entry was created.
- Secret values should remain in a credential system and appear only as scoped
  capability references.
- Cross-project Memory is forbidden unless a later federation specification
  defines identity, consent, provenance, and revocation.
- Model providers receive only the Workspace fields authorized for that Session.
- Derived content is treated as untrusted input when it can contain tool output
  or external text.

## 13. Fresh-session recovery

A conforming recovery path:

1. authenticates the Steward or Agent;
2. resolves its current Role and Assignment;
3. reads the latest permitted project sequence;
4. builds a new Workspace from authoritative state;
5. retrieves only relevant, visible, non-invalidated Memory;
6. reports pending approvals, blockers, Leases, and allowed next actions;
7. does not require the prior provider thread or full chat transcript.

## 14. Conformance

A conforming implementation must prove that:

1. every Workspace is bound to one project sequence and expiry;
2. mandatory execution context cannot be silently omitted;
3. stale Workspaces cannot overwrite newer state;
4. every Memory entry resolves to declared sources or is marked orphaned;
5. summaries and confidence never override authoritative sources;
6. current permissions filter previously generated Memory;
7. source supersession or redaction invalidates dependent projections;
8. promotion creates a governed POM object rather than changing authority in
   place;
9. a fresh Session reconstructs current context without prior chat history.

## 15. Deferred work

Machine-readable Workspace and Memory schemas, ranking algorithms, embedding
providers, encryption at rest, large Artifact retrieval, legal retention
profiles, cross-project learning, and cryptographic provenance are deferred.
