# PKR Agent Session Protocol v0.3

- Status: Draft
- Index: [PKR specification index](README.md)
- Scope: Agent capability handshake, Assignment, Session, Lease, messaging, and callback
- Depends on: [PKR Object Model v0.2](0001-pkr-object-model-v0.2.md)
- Reuses: [PKR Runtime Protocol v0.2](0004-pkr-runtime-protocol-v0.2.md)
- Orchestration boundary: [PKR Steward and LPS Boundary v0.3](0005-pkr-steward-lps-boundary-v0.3.md)

## 1. Purpose

This RFC defines a provider-neutral contract for assigning governed work to
heterogeneous Agents and coordinating their execution without treating a model
prompt, provider thread, or process as durable Agent identity.

## 2. Identity separation

The POM Agent object represents a registered project principal with declared
provider, capabilities, permissions, ownership, and lifecycle. Runtime execution
uses separate control records:

- `Assignment`: one bounded offer of work for one Task lane;
- `AgentSession`: one provider execution context acting as an Agent;
- `Lease`: time-bounded exclusive or shared authority to execute an Assignment;
- `AgentMessage`: an attributable protocol message between principals or Runtime
  components.

These are Runtime control and protocol records, not new POM core object kinds.
A provider thread ID MAY locate an AgentSession but MUST NOT substitute for an
Agent ID, Role, Assignment, or Lease.

### 2.1 Logical Runtime operations

The Agent coordination surface exposes:

| Operation | Purpose | Mutation |
| --- | --- | --- |
| `offerAssignment(intent)` | Create and deliver one idempotent work offer | yes |
| `respondAssignment(assignment, response)` | Accept or reject an offer | yes |
| `openAgentSession(agent, capabilityStatement)` | Bind one provider context | yes |
| `closeAgentSession(session, reason)` | Close or fail a provider context | yes |
| `acquireLease(assignment, session)` | Grant time-bounded execution authority | yes |
| `renewLease(lease, expectedRevision)` | Extend an active Lease | yes |
| `releaseLease(lease, reason)` | End authority voluntarily | yes |
| `revokeLease(lease, reason)` | End authority by policy or owner action | yes |
| `submitAgentMessage(message)` | Validate, deduplicate, route, and record a message | yes |
| `getControlRecord(projectId, kind, id, selector)` | Read one coordination record | no |
| `listControlRecords(projectId, kind, query)` | Read a sequence-bound collection | no |

Mutations use authenticated actor, Role, Workflow, scope, decision basis,
idempotency, optimistic concurrency, result, and event semantics compatible with
the Runtime Protocol. Machine-readable action envelopes are deferred to v0.4.

## 3. Capability handshake

Before an Agent accepts work, its adapter presents a signed or host-authenticated
capability statement containing:

- registered Agent ID and provider adapter ID/version;
- model or execution-class identifier where disclosure is allowed;
- supported protocol versions;
- available tool capabilities such as filesystem, terminal, Git, browser,
  network, deployment, or external connectors;
- supported input, Artifact, and evidence formats;
- execution limits such as context, concurrency, duration, or quota;
- isolation and credential-handling properties;
- statement issue time and expiry.

The Runtime matches capabilities to the Assignment requirements. Capability
claims are eligibility inputs, not permission grants. Effective permission is
the intersection of Agent, Role, Workflow, Assignment, Lease, and host policy.

## 4. Assignment record

An Assignment contains:

```yaml
assignmentId: assignment_01J...
projectId: project_01J...
taskId: task_01J...
taskRevision: 7
workflowId: workflow_01J...
workflowRevision: 12
roleId: role_developer
objective: Implement the bounded login rate-limit lane.
allowedScope: [src/identity/**, tests/identity/**]
forbiddenScope: [infra/production/**]
acceptanceRefs: [task_01J...#acceptance-1]
verificationPolicyRef: verification-policy/default@3
requiredCapabilities: [filesystem.write, terminal, git.diff]
expectedArtifacts: [source-change, test-evidence]
state: offered
revision: 1
projectSequence: 1842
```

An Assignment MUST bind exact Task and Workflow revisions, one Role, allowed and
forbidden scope, acceptance, Verification policy, expected Artifacts, capability
requirements, callback contract, and idempotency key.

## 5. Assignment lifecycle

```text
prepared -> offered -> accepted -> running <-> blocked -> submitted -> closed
              |           |          |             |           |
              +-> rejected+----------+-------------+----------> cancelled
                          +----------+-------------+----------> expired
                                     +------------------------> failed
```

Rules:

- `prepared` is not live and grants no execution authority;
- `offered` means delivery was attempted and is addressable by idempotency key;
- `accepted` requires a compatible handshake and active Agent and Role;
- `running` requires an active Lease;
- `blocked` names the dependency and allowed next actions;
- `submitted` means a callback was committed, not that the Task passed;
- `closed` requires callback absorption and a recorded disposition;
- terminal cancellation, expiry, or failure preserves partial Artifacts and
  evidence with provenance.

## 6. AgentSession record and lifecycle

An AgentSession binds one Agent to one authenticated provider execution context
and may serve one or more explicitly linked Assignments when policy permits.

```text
opening -> active <-> suspended -> closing -> closed
    |         |                      |
    +---------+---------------------> failed
              +--------------------> expired
```

An active Session records its provider locator, adapter version, protocol
version, capability statement digest, active Assignment IDs, last heartbeat,
and expiry. Provider-local conversation history is non-authoritative context.

A suspended Session cannot begin new external effects. A closing Session may
return its final callback but cannot expand scope.

## 7. Lease semantics

A Lease contains one `leaseId`, Assignment, AgentSession, holder Agent, scope,
mode, acquired time, expiry, heartbeat policy, and revision.

Lease mode is:

- `exclusive`: only the holder may execute the Assignment lane;
- `shared`: multiple holders are permitted only when the Workflow declares a
  collision-safe shared scope.

A Lease may be renewed, released, revoked, or expire. Renewal uses optimistic
concurrency and MUST NOT change Assignment scope. Revocation and expiry emit
events immediately.

After Lease loss, an Agent MUST stop new mutating effects. A late callback MAY
be retained as untrusted or orphan evidence, but it MUST NOT be absorbed as the
active Assignment result without an explicit recovery Decision or Workflow
path.

## 8. AgentMessage envelope

Every protocol message contains:

```yaml
apiVersion: pkr.dev/v0.3
kind: AgentMessage
messageId: msg_01J...
projectId: project_01J...
type: pkr.agent.callback
sender:
  principalId: agent_01J...
  sessionId: session_01J...
recipient:
  component: orchestrator
assignmentId: assignment_01J...
leaseId: lease_01J...
correlationId: dispatch_01J...
causationId: msg_01H...
projectSequence: 1842
issuedAt: 2026-07-17T12:00:00Z
payload: {}
```

`messageId` is the idempotency key. `correlationId` groups one dispatch or
handoff flow. `causationId` identifies the prior message or command that caused
the message. The Runtime authenticates sender identity out of band.

## 9. Message types

The portable protocol includes:

- `assignment.offer`, `assignment.accept`, and `assignment.reject`;
- `execution.started`, `execution.progress`, and `execution.heartbeat`;
- `execution.blocked` and `execution.resumed`;
- `execution.callback`;
- `handoff.request`, `handoff.accept`, and `handoff.complete`;
- `assignment.cancel` and `session.close`;
- `lease.renew`, `lease.release`, and `lease.revoke`;
- `protocol.error`.

Unknown namespaced extension messages may be stored and routed only when the
installed Package and receiving adapter declare support. Unknown core messages
fail explicitly.

## 10. Callback contract

A callback is a terminal or checkpoint report with:

- outcome: `verified`, `partial`, `blocked`, or `externalSignoffBlocked`;
- completed and incomplete acceptance identifiers;
- blocker records with owner and required next action;
- created or changed Artifact references and digests;
- Verification attempt and evidence references;
- committed Runtime command and event references, if any;
- scope declaration and detected boundary violations;
- recommended next action;
- provider-local diagnostics labeled non-authoritative.

`verified` means the callback claims its required evidence is present. The
Runtime and applicable Verification policy still decide whether that claim is
valid. A callback MUST NOT contain credentials or embed mutable copies of
authoritative objects.

## 11. Handoff and reassignment

A handoff preserves the original Assignment unless scope or acceptance changes.
It records:

- outgoing Session and final project sequence observed;
- partial Artifacts, evidence, blockers, and uncommitted work;
- incoming Agent capability match;
- old Lease release or revocation;
- new Session and Lease acquisition;
- one correlation chain across both Agents.

Changing objective, scope, acceptance, Workflow revision, or Task revision
requires Assignment replacement rather than silent handoff mutation.

## 12. Direct Agent communication

Agents MAY communicate directly only through authenticated AgentMessages
authorized by the active Workflow and Assignment scopes. A receiving Agent MUST
not treat another Agent's claim as project truth. It resolves referenced PKR
objects and evidence at the stated project sequence before acting.

Delegation that creates new work requires a child Assignment or an orchestrator
request. Forwarding a prompt alone does not delegate authority.

## 13. Failure and recovery

- Delivery timeout is indeterminate until idempotency lookup completes.
- Missing heartbeat expires the Lease according to policy, not UI appearance.
- Provider quota or tool absence is infrastructure failure, not Task failure.
- Duplicate live exclusive Leases are a Runtime invariant violation and block
  both holders until reconciled.
- On restart, non-terminal records are rebuilt from committed state and events.
- Partial outputs survive cancellation when their provenance is valid.

## 14. Conformance

A conforming implementation must prove that:

1. provider thread IDs cannot authorize work;
2. capability claims do not exceed effective permission;
3. duplicate offers and messages are idempotent;
4. `running` is unreachable without an active Lease;
5. exclusive Lease conflicts reject all but one holder;
6. expired or revoked holders cannot commit an active callback;
7. callbacks are correlated, scope-checked, and independently verified;
8. handoff preserves provenance and revokes prior execution authority;
9. restart recovery produces no duplicate live Assignment or Lease.

## 15. Deferred work

Machine-readable control record and message schemas, cryptographic message
signing, broker delivery guarantees, streaming payloads, provider-specific
adapters, distributed clock policy, and billing or quota settlement are deferred
to later specifications.
