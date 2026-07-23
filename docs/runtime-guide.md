# Runtime and Supervisor Guide

PKR separates four responsibilities:

| Responsibility | Authoritative boundary |
| --- | --- |
| Runtime safety and control | `.pkr/runtime.sqlite`, ordered events, revisions, command digests, and Leases |
| Supervisor liveness and drive | An explicitly started `supervise --once` or `--watch` process that performs one deterministic reconcile action |
| Agent/Provider execution | A bounded Workspace and non-authoritative AgentMessage work report |
| Independent Verification and acceptance | A fresh Repository evidence collection and Runtime `verify` transition by a distinct verifier |

The Supervisor is a drive loop, not a second Runtime. It reads the current
Task, Assignment, Session, Lease, external-effect journal, and clarification
records from SQLite, chooses at most one legal action, and returns a structured
`pkr.supervisor-result/v1` result. Boards, projections, host session locators,
and optional Skill metadata cannot authorize a state transition.

## Explicit configuration

Automatic Provider selection is not supported. Create `.pkr/supervisor.json`
with explicit bindings:

```json
{
  "version": "pkr.supervisor/v1",
  "taskId": "task_...",
  "agentId": "agent_...",
  "provider": { "file": ".pkr/provider.json" },
  "verification": {
    "file": ".pkr/verification.json",
    "actorId": "agent_independent_verifier"
  },
  "requiredCapabilities": ["filesystem.read", "filesystem.write", "terminal"]
}
```

The configured Agent must already be registered and active. The Provider file
must declare one bounded Adapter command. The Verification plan is loaded and
run independently; its commands and Git evidence are not taken from the
Provider callback. A required Skill is only a typed, optional capability hint
resolved by the host; a Skill cannot provide identity, permission, authority,
or acceptance.

Run one action or let the explicit watch loop continue until a terminal state:

```powershell
pkr supervise --once --project C:\path\to\repo
pkr supervise --watch --interval 1000 --project C:\path\to\repo
```

`--once` is composable and testable. Each result includes the observed event
sequence, Task and Assignment state, action, resulting state, attention reason,
and next action.

## Recovery rules

- `backlog` dispatches one explicitly bound Adapter lane.
- `inProgress` renews a due Lease, expires an elapsed Lease, or executes the
  existing LPS lane. A pending Provider effect is ambiguous and is never
  retried automatically.
- `verifying` runs a fenced independent Verification effect. A successful
  effect is replayed from SQLite; a pending effect stops at owner attention.
- `done` and `cancelled` are idempotent no-ops. Other `blocked` states require
  owner review. `LeaseExpired` may receive one governed replacement dispatch
  only when no external effect remains unabsorbed.
- A protected or unresolved clarification stops at `owner_attention`; the
  Supervisor never answers or approves it.

This local Supervisor loop does not claim an OS sandbox, a production Provider,
public/Owner acceptance, or a hosted service. Fake and local Adapter tests are
contract evidence only; live Provider, repository, newcomer, and production
acceptance remain separate gates.
