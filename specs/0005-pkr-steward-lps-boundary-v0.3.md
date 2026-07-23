# PKR Steward and LPS Boundary v0.3

- Status: Draft
- Index: [PKR specification index](README.md)
- Scope: Human entry point, orchestration boundary, and authority ownership
- Depends on: [PKR Object Model v0.2](0001-pkr-object-model-v0.2.md)
- Reuses: [PKR Runtime Protocol v0.2](0004-pkr-runtime-protocol-v0.2.md)
- Agent protocol: [PKR Agent Session Protocol v0.3](0007-pkr-agent-session-protocol-v0.3.md)

## 1. Purpose

This RFC defines how a human-facing Project Steward and an orchestrator such as
LPS participate in a PKR Project without creating privileged mutation paths or
competing project truth.

The Steward is the default conversational entry point. LPS is the reference
orchestration adapter. Neither component is required to be a specific model,
process, transport, or product implementation.

## 2. Responsibility boundary

| Component | Primary responsibility | Authority source |
| --- | --- | --- |
| PKR Runtime | validate and commit project truth | Object Model, active policy, and Runtime protocol |
| Steward | understand intent, explain state, prepare proposals, request approval | assigned Role, Workflow, Workspace, and human input |
| LPS adapter | plan lanes, select eligible Agents, dispatch, monitor, and absorb callbacks | active Task, Workflow, Agent records, and session protocol |
| Agent adapter | translate provider capabilities and messages | registered Agent permissions and active Assignment |
| Tool adapter | perform a declared external operation and return evidence | scoped command or Assignment capability grant |

The Runtime is the sole authority for whether a mutation committed, a Task is
complete, a Verification passed, or a policy version is active.

## 3. Steward contract

A Steward MUST be represented by an active Agent principal acting through an
active Role. A Steward MAY:

- receive human intent and ask bounded clarification questions;
- read a Workspace and relevant Memory projection;
- prepare Mission, Goal, Task, Decision, Workflow, or other governed changes;
- submit authorized Runtime commands;
- present plans, risks, evidence, and pending approvals;
- request LPS planning or dispatch after the governing state commits.

A Steward MUST NOT:

- treat conversation text as committed project truth;
- claim approval from silence or model inference;
- bypass Role, Workflow, Constraint, Decision, or Verification requirements;
- directly mark a Task `done` from a worker narrative;
- conceal a conflict, rejected command, stale Workspace, or missing evidence;
- grant itself or another Agent new permissions outside governance.

Material changes use an accepted Decision as required by the Object Model. The
Steward MAY draft that Decision, but an authorized principal must accept it.

## 4. Human interaction states

A portable Steward exposes these logical interaction states:

```text
listening
  -> clarifying
  -> proposing
  -> awaitingApproval
  -> committing
  -> orchestrating
  -> reporting
  -> listening

Any state -> blocked
Any non-committing state -> cancelled
```

These states are interaction state, not POM object phases. Implementations MAY
persist them in an AgentSession control record. Only a committed Runtime command
changes project truth.

A proposal MUST identify:

- the human outcome it serves;
- objects and revisions it would affect;
- the active Workflow and Role;
- material Decisions or approvals required;
- acceptance, Verification, and expected Artifacts;
- actions that remain reversible and the next irreversible action.

## 5. LPS adapter contract

LPS consumes committed PKR state and produces governed orchestration requests.
It MAY:

- decompose an authorized Task into bounded execution lanes;
- retain module owners and open short-lived execution sessions;
- choose an Agent whose registered capabilities satisfy the lane;
- request Assignment, AgentSession, and Lease control records;
- route progress, blocker, callback, handoff, cancellation, and closure messages;
- select assurance profiles appropriate to the next irreversible action;
- maintain a rebuildable board or cache for operator ergonomics.

LPS MUST NOT:

- create a second authoritative Mission, Goal, Task, or completion state;
- dispatch work before the Task and applicable Workflow are committed;
- mark an Agent live before session delivery is confirmed;
- treat a provider thread identifier as an Agent identity;
- open a dependent lane before its required callback or gate is committed;
- convert infrastructure failure or missing evidence into product success;
- continue a lane after its Lease is expired, revoked, or released.

## 6. Projection and reconciliation

Every LPS control view MUST carry the PKR `projectId` and source
`projectSequence`. Entries that describe Tasks, Workflows, Agents, Artifacts, or
Verifications MUST also carry the relevant object revision.

When a local LPS board conflicts with PKR:

1. stop mutations derived from the conflicting entry;
2. read the latest PKR objects and events;
3. classify the board entry as stale, duplicate, missing, or externally changed;
4. rebuild or explicitly reconcile the projection;
5. resume only from the committed PKR state.

An orchestrator cache MAY contain annotations that are not project truth. Such
fields must be labeled local or derived and must not authorize Runtime commands.

## 7. Dispatch transaction

A dispatch is valid only when all stages complete:

1. read a sequence-bound Workspace for the planning principal;
2. identify one committed Task and exact Workflow revision;
3. derive one bounded lane with scope, non-goals, acceptance, and capability
   requirements;
4. select an eligible active Agent;
5. create or reuse an Assignment according to idempotency rules;
6. deliver the Assignment and confirm the AgentSession;
7. acquire a Lease before execution begins;
8. commit the live orchestration projection after real delivery is known.

A timeout during delivery is indeterminate, not proof of failure. LPS MUST query
the Assignment and Session by their idempotency and correlation identifiers
before retrying.

## 8. Callback absorption

Worker output becomes eligible project evidence only after the Runtime accepts a
correlated callback under the active Assignment and Lease rules.

LPS classifies a callback as:

- `verified`: its declared acceptance and current required evidence are present;
- `partial`: useful output exists but required closure evidence is missing;
- `blocked`: a named dependency prevents progress;
- `externalSignoffBlocked`: the next action requires an external approval.

The classification does not itself transition the Task. LPS submits the needed
Artifact, Verification, Issue, or Task commands, and the Runtime decides each
commit independently.

## 9. Progressive assurance

Delivery progress and assurance confidence are separate. LPS MAY defer an
expensive or unavailable check when the active Workflow permits continued
reversible work. It MUST preserve:

- the unmet gate;
- the reason and last evidence;
- the action it blocks;
- the responsible Role or Agent;
- the retry trigger or deadline.

Security, privacy, destructive data changes, and public release retain their
explicit gates. Assurance deferral cannot weaken a non-waivable Constraint.

## 10. Recovery

After Steward, LPS, or provider restart:

1. load the latest Manifest and project sequence;
2. list non-terminal Assignments, Sessions, and Leases;
3. expire or reconcile records whose provider state cannot be confirmed;
4. rebuild the orchestration view from PKR events and current records;
5. issue fresh Workspaces before any new mutation;
6. report unresolved ambiguity rather than guessing that work completed.

Recovery MUST NOT depend on previous conversational context or UI unread state.

## 11. Conformance

A conforming integration must prove that:

1. Steward proposals do not mutate truth before Runtime commit;
2. material changes pause for the required Decision or approval;
3. LPS can rebuild its live control view from PKR records and events;
4. duplicate dispatch attempts resolve to one live Assignment;
5. stale boards and Workspaces cannot overwrite newer state;
6. callbacks without a valid Assignment, Session, and correlation fail;
7. callback classification cannot bypass Task Verification;
8. restart recovery never treats conversation history as authority.

## 12. Deferred work

This RFC does not define a conversational UI, natural-language planner, provider
selection algorithm, LPS transport binding, hosted service topology, or billing
policy. Those implementations must preserve the authority and recovery boundary
defined here.
