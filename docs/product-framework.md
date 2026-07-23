# PKR Project Framework

PKR is a framework for operating AI-native software projects, not a rulebook
or wrapper for one model, Agent host, or CLI. Its purpose is to keep project
intent, facts, decisions, permissions, work, evidence, and recovery in one
governed Runtime.

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
reference orchestration component. Agents and tools participate through
bounded Workspaces and work reports; optional execution Adapters are an
integration detail. None of them owns project truth or acceptance.

## Authority rule

PKR owns authoritative state, policy, evidence, events, projections, and
recovery. Derived boards, Memory indexes, session locators, and repository
views cannot become a second source of truth. A successful Agent report is
still only a report until the Runtime accepts independent Verification evidence.

The detailed versioned design contracts remain in the
[`specs/` index](../specs/README.md); this page is the product-level explanation
of how they fit together. The [v1 stable contract](release/v1-stable-contract.md)
is the accepted compatibility inventory for the current public release.

## Evidence boundary

Automated tests may use a fake process fixture to exercise the optional Adapter
protocol. That proves parsing, process bounds, and callback handling only; it
is not a product dependency or model-host compatibility claim. A real Agent
audit is a separately labeled integration observation, and neither kind of work
report is Repository Verification or Runtime acceptance. See
[the architecture](architecture.md) and
[evidence classification](audits/evidence-classification.md).
