# PKR

PKR (Project Kernel Runtime, initially Project Knowledge Runtime) is an open
runtime specification for AI-native software projects.

PKR does not help an AI write code. It gives humans, agents, tools, and
workflows one shared set of project rules and one authoritative project state.
The repository is one source of artifacts in that runtime, not the runtime
itself.

## Status

PKR v0.7 is a **local reference Runtime and persistent intelligence loop**
proving the v0.2 object model, v0.4 coordination contracts, governed Steward
intake, LPS-compatible dispatch, a real Codex CLI Agent adapter,
provenance-aware Memory, portable Workflows, atomic Packages, and two starter
project Profiles. The API remains pre-stable. Hosted deployment and cloud
provider adapters are not claimed.

The current specification set is:

- [PKR v0.1 definition](specs/0000-pkr-v0.1.md): vision, scope, runtime modules,
  and roadmap.
- [PKR Object Model v0.2 draft](specs/0001-pkr-object-model-v0.2.md): core
  objects, relationships, lifecycle rules, events, and conformance rules.
- [PKR Core Schema v0.2 draft](specs/0002-pkr-core-schema-v0.2.md): field-level
  representation and the structural-versus-semantic validation boundary.
- [PKR v0.2 JSON Schema](schemas/v0.2/pkr-object.schema.json): machine-readable
  Draft 2020-12 contract for all fourteen core object kinds.
- [PKR Manifest and Bootstrap v0.2 draft](specs/0003-pkr-manifest-bootstrap-v0.2.md):
  project identity, genesis authority, and atomic initialization.
- [PKR v0.2 Bootstrap Schema](schemas/v0.2/pkr-bootstrap.schema.json):
  machine-readable contract for bootstrap requests, Manifests, and Genesis
  Records.
- [PKR Runtime Protocol v0.2 draft](specs/0004-pkr-runtime-protocol-v0.2.md):
  logical Runtime API, governed mutations, events, results, and read
  consistency.
- [PKR v0.2 Runtime Schema](schemas/v0.2/pkr-runtime.schema.json):
  machine-readable command, event, and result contract.
- [PKR Steward and LPS Boundary v0.3 draft](specs/0005-pkr-steward-lps-boundary-v0.3.md):
  human entry point, reference orchestration, authority, and recovery boundary.
- [PKR Workflow and Verification Profile v0.3 draft](specs/0006-pkr-workflow-verification-v0.3.md):
  portable custom state machines, deterministic guards, and evidence gates.
- [PKR Agent Session Protocol v0.3 draft](specs/0007-pkr-agent-session-protocol-v0.3.md):
  capability handshake, Assignment, Session, Lease, messages, and callbacks.
- [PKR Workspace and Memory v0.3 draft](specs/0008-pkr-workspace-memory-v0.3.md):
  bounded context, persistent derived Memory, retention, and promotion.
- [PKR Package and Governed Evolution v0.3 draft](specs/0009-pkr-package-evolution-v0.3.md):
  package compatibility, project profiles, canaries, promotion, and rollback.
- [PKR v0.4 Coordination Record and Action Catalog](specs/0010-pkr-v0.4-record-action-catalog.md):
  authority classes, control-record ownership, operations, reads, and stable
  coordination errors.

## Current boundary

The public implementation boundary is v0.7. Work on v0.8/v0.9 kernel
extensions is paused while this Runtime is exercised in real projects. Hosted
deployment, a package registry, and additional model adapters remain outside
this release.

## Operating model

- **PKR Kernel** owns authoritative state, permissions, policy, events,
  evidence, projections, and recovery semantics.
- **Project Steward** is the governed conversational entry point for a human. It
  prepares proposals and requests approval; it is not a root bypass.
- **LPS** is the reference orchestrator. It plans, dispatches, monitors, and
  absorbs callbacks from PKR state without creating a second source of truth.
- **Agent and tool adapters** translate provider capabilities and external
  effects while PKR remains provider- and transport-neutral.

The first product proof is a project flow from `pkr init`, through one
Codex-backed `pkr run`, to independently verified Task completion, process
restart, and a durable `pkr status` audit.

## Design principles

1. A project has one authoritative runtime state.
2. Every mutation is attributable, authorized, and explainable.
3. `Done` means required verification passed, not merely that work stopped.
4. Agents consume a task-scoped workspace projection, not the entire repository.
5. Packages extend the core object model without redefining it.
6. Orchestrator boards and Memory indexes are rebuildable projections, never a
   second project authority.
7. Self-evolution creates versioned proposals that pass the same governance,
   verification, promotion, and rollback rules as other material changes.

## Validate the specification

With Python 3.11 and the dependencies in `conformance/requirements.txt`:

```powershell
py -3.11 -B conformance/validate_core_schema.py
py -3.11 -B conformance/validate_bootstrap_schema.py
py -3.11 -B conformance/validate_runtime_schema.py
py -3.11 -B conformance/validate_coordination_schema.py
py -3.11 -B conformance/validate_coordination_semantics.py
```

The runners check both schema meta-models, valid fixtures for every core and
control-record kind, and targeted invalid fixtures. They do not claim to
perform POM graph, lifecycle, authentication, or transaction validation.

The v0.4 coordination validators add structural coverage for Workflow, Agent,
Workspace, Memory, Package, and coordination protocol records plus an in-memory
semantic harness. They do not claim to prove durable Runtime persistence.

## Runtime CLI

Requires Node 24 or newer. Install the public package:

```powershell
npm install --global pkr-runtime
```

The public surface is three commands:

```powershell
pkr init --project C:\path\to\project --name my-project
pkr run "Add one bounded feature" --project C:\path\to\project --verify "npm test"
pkr status --project C:\path\to\project
```

`pkr run` sends the bounded request to the locally installed Codex CLI, records
the Assignment and callback in PKR, then runs `--verify` in a separate process.
Only a repository change followed by an exit code of zero can produce `done`.
`pkr status` reopens `.pkr/runtime.sqlite` and reports the persisted Task,
Assignment, callback evidence, and verification state.

The Runtime stores authority in `.pkr/runtime.sqlite` and rebuilds inspectable
JSON under `.pkr/projections/`. Projection files are never mutation input. See
[Decision 0001](docs/decisions/0001-reference-runtime-layout.md) for the storage
and dependency boundary.

## Reproducible proof

The checked-in [three-command demo](examples/three-command-demo/README.md)
uses a temporary Git project. In roughly 3--5 minutes it has Codex modify a
file, PKR record the Assignment and evidence, an independent test pass, a
fresh-process restart, and `pkr status` display `completed`.

The [LPS adapter mapping](docs/integrations/lps.md) explains how worker, gate,
callback, and board state are derived from PKR without becoming a second truth.

The v0.7 Runtime also exposes `memory derive|list|promote`,
`profile install|list`, `workflow start|transition`, and
`package uninstall|rollback`. Memory entries are derived from exact source
revisions and become persistently invalid when those sources change. Profile
Packages contribute declarative Workflow definitions; they cannot execute
code, access time or network state, or mutate POM lifecycle state.

## Public release boundary

This repository publishes the v0.7 Runtime and specification under the
Apache-2.0 license. Development notes and v0.8/v0.9 experiments are kept out
of the public tree while the v0.7 soak runs collect failure, recovery, and
audit evidence.
