# Why PKR

PKR is an AI-native project framework and local Runtime. It gives a project one
place for intent, decisions, work, evidence, memory, and recovery. The point is
not to make one AI tool smarter; it is to make the project state trustworthy
when people, Agents, and tools work across sessions.

## The gap

An AI tool can read a request, edit files, and report that it finished. That
report is useful, but it is not project truth. Without a governed Runtime, a
team still has to reconstruct which goal was approved, what work was claimed,
which files changed, whether the checks were independent, what failed, and how
to resume safely after a restart.

## What PKR adds

| Without a project Runtime | With PKR |
| --- | --- |
| Request and implementation are mixed together | Intent becomes explicit Mission, Goal, and Task state |
| A worker success message is treated as completion | Work reports stay non-authoritative until independent Verification |
| Boards and notes drift from source state | SQLite is authoritative; projections and Memory rebuild from it |
| Failure is a chat message or lost process | Blocked state, evidence, leases, and restart recovery are durable |
| Acceptance is implicit | Repository Verification and Runtime acceptance are separate records |

## The core loop

1. A human or Agent submits intent to the governed Steward.
2. PKR records a bounded Goal and Task and exposes the next allowed action.
3. An Agent or tool claims a scoped Workspace and reports the work it attempted.
4. A distinct Repository Verifier recomputes Git and command evidence.
5. Runtime acceptance, blocking, or recovery is recorded in SQLite.
6. Status, Memory, and orchestration views are rebuilt from authoritative state.

This is the framework contract. Optional execution integrations may participate
in step 3, but they do not own project truth, verification, or acceptance.

## What PKR is not

- Not a vendor-specific rule set, CLI wrapper, or model prompt library.
- Not a cloud control plane, hosted Agent marketplace, or multi-tenant service.
- Not an operating-system sandbox, VM, credential vault, or guarantee against a
  trusted host process damaging the local machine.
- Not a claim of universal model, Agent-host, operating-system, or production
  support.
- Not a replacement for project-specific tests, human approval, or security
  review.

## Read next

- [Architecture](architecture.md) for the authority and evidence diagram.
- [Source quickstart](quickstart.md) for the reproducible repository path.
- [Operational limits](operations/limits.md) and
  [recovery](operations/recovery-and-migrations.md) for safety and restart
  behavior.
- [Stable contract](release/v1-stable-contract.md) for candidate API boundaries.
