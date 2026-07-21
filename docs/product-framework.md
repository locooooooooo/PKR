# PKR Project Framework

PKR is a framework for operating AI-native software projects, not a rulebook
for using one Agent or Provider. Its purpose is to keep project intent, facts,
decisions, permissions, work, evidence, and recovery in one governed Runtime.

## Framework responsibilities

- **Mission, Goal, and Task:** keep purpose, outcomes, and bounded work explicit.
- **Knowledge, Decision, and Constraint:** keep facts, choices, and
  non-negotiable rules authoritative.
- **Workflow and Verification:** control permitted transitions and define what
  evidence makes work done.
- **Agent, Role, and Workspace:** bind capabilities and permissions to the
  bounded context an Agent may act on.
- **Memory, Artifact, and Event:** preserve provenance, outputs, and an
  auditable history across sessions.

The Project Steward is the human-facing governed entry point. LPS is a
reference orchestration adapter. Provider and tool adapters are replaceable
execution boundaries; none of them owns project truth or acceptance.

## Authority rule

PKR owns authoritative state, policy, evidence, events, projections, and
recovery. Derived boards, Memory indexes, provider locators, and repository
views cannot become a second source of truth. A successful Agent report is
still only a report until the Runtime accepts independent Verification evidence.

The detailed contracts remain in `specs/`; this page is the product-level
explanation of how those contracts fit together.

## Evidence boundary

Automated tests may use a fake Provider fixture to exercise the Adapter
protocol. That proves parsing, process bounds, and callback handling only. A
real Agent audit is a separately labeled observation of an external Agent host,
and neither kind of work report is Repository Verification or Runtime
acceptance. See [the architecture](architecture.md) and
[evidence classification](audits/evidence-classification.md).
