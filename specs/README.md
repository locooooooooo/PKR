# PKR Specifications

This directory contains PKR's public, versioned design documents. It preserves
the reasoning and protocol definitions that led from the initial vision to the
shipped Runtime. It is not, by itself, a claim that every Draft surface is part
of the current stable compatibility promise.

For the accepted public release surface, start with the
[PKR v1 stable contract](../docs/release/v1-stable-contract.md) and its
[machine inventory](../docs/release/v1-contract-manifest.json).

## Document status

- **Vision baseline** records the product direction and original scope. It is
  design context, not a machine compatibility contract.
- **Draft** is a published RFC. It may use normative language and may have a
  schema or conformance suite, but Draft status alone does not make the whole
  document a stable release promise.
- **Implemented milestone** records a verified development version that was not
  independently released.
- **Public prerelease baseline** records a tagged public version before the
  stable compatibility contract.
- **Integrated milestone** records a version whose outcomes were folded into a
  later release without a standalone tag or Release.
- **Stable source release** records a published GitHub source version governed
  by the accepted v1 compatibility contract.
- **Stable release contract** is the accepted compatibility inventory under
  `docs/release/`. It binds the shipped CLI, TypeScript exports, schemas,
  records, events, support matrix, and semantic-versioning policy.

The version numbers serve different purposes. RFC and schema versions describe
protocol evolution; the package version describes the public source release.
The v1 contract deliberately binds both v0.2 and v0.4 schema families. When a
Draft RFC and the accepted v1 inventory differ, use the accepted v1 inventory
for compatibility and release decisions while retaining the RFC as versioned
design context.

## Catalog

| ID | Status | Subject | Machine-readable companion |
| --- | --- | --- | --- |
| [0000](0000-pkr-v0.1.md) | Vision baseline | Product vision, scope, modules, and roadmap | None |
| [0001](0001-pkr-object-model-v0.2.md) | Draft | Core objects, relations, lifecycles, and invariants | [v0.2 object schema](../schemas/v0.2/pkr-object.schema.json) |
| [0002](0002-pkr-core-schema-v0.2.md) | Draft | Field-level representation and validation boundary | [v0.2 object schema](../schemas/v0.2/pkr-object.schema.json) |
| [0003](0003-pkr-manifest-bootstrap-v0.2.md) | Draft | Project identity, genesis authority, and bootstrap | [v0.2 bootstrap schema](../schemas/v0.2/pkr-bootstrap.schema.json) |
| [0004](0004-pkr-runtime-protocol-v0.2.md) | Draft | Runtime commands, events, results, and read consistency | [v0.2 Runtime schema](../schemas/v0.2/pkr-runtime.schema.json) |
| [0005](0005-pkr-steward-lps-boundary-v0.3.md) | Draft | Steward, orchestration, authority, and recovery boundary | [v0.4 coordination schema](../schemas/v0.4/pkr-coordination.schema.json) |
| [0006](0006-pkr-workflow-verification-v0.3.md) | Draft | Workflows, deterministic guards, and evidence gates | [v0.4 workflow schema](../schemas/v0.4/pkr-workflow.schema.json) |
| [0007](0007-pkr-agent-session-protocol-v0.3.md) | Draft | Agent capability, assignment, session, lease, and messaging | [v0.4 Agent schema](../schemas/v0.4/pkr-agent.schema.json) |
| [0008](0008-pkr-workspace-memory-v0.3.md) | Draft | Bounded Workspace, derived Memory, retention, and promotion | [v0.4 context schema](../schemas/v0.4/pkr-context.schema.json) |
| [0009](0009-pkr-package-evolution-v0.3.md) | Draft | Package compatibility and governed evolution | [v0.4 Package schema](../schemas/v0.4/pkr-package.schema.json) |
| [0010](0010-pkr-v0.4-record-action-catalog.md) | Draft | Coordination records, actions, reads, and stable errors | [v0.4 coordination Runtime schema](../schemas/v0.4/pkr-coordination-runtime.schema.json) |
| [0011](0011-pkr-v0.5-reference-runtime.md) | Implemented milestone | Transactional reference Runtime and JSON CLI | [Runtime layout decision](../docs/decisions/0001-reference-runtime-layout.md) |
| [0012](0012-pkr-v0.6-steward-lps-orchestration.md) | Implemented milestone | Steward intake, LPS orchestration, Agent work, and recovery | [LPS integration guide](../docs/integrations/lps.md) |
| [0013](0013-pkr-v0.7-persistent-intelligence.md) | Public prerelease baseline | Memory, Workflow, Profile, and Package lifecycle | [`v0.7.0-alpha.1` Release](https://github.com/locooooooooo/PKR/releases/tag/v0.7.0-alpha.1) |
| [0014](0014-pkr-v0.8-governed-evolution.md) | Integrated milestone | Candidate evaluation, promotion, monitoring, and rollback | [v1 experimental inventory](../docs/release/v1-stable-contract.md#experimental-surfaces) |
| [0015](0015-pkr-v0.9-release-hardening.md) | Integrated milestone | Compatibility, recovery, security, and release gates | [v1 gate register](../docs/release/v1.0-blockers.md) |
| [0016](0016-pkr-v1.0-stable-contract.md) | Stable source release | First accepted stable compatibility contract | [v1 machine inventory](../docs/release/v1-contract-manifest.json) |
| [0017](0017-pkr-v1.1-evidence-integrity.md) | Stable source release | Content-addressed evidence, migration, restore, and sharing | [v1.1 release specification](../docs/release/v1.1.0.md) |
| [0018](0018-pkr-v1.2-supervisor-runner.md) | Stable source release; Supervisor experimental | Explicit Supervisor/Runner and restart-safe effect fencing | [v1.2 release specification](../docs/release/v1.2.0.md) |

Schema shape is only one part of conformance. The validators and positive and
negative cases under [`conformance/`](../conformance/) cover the associated
structural and semantic rules.

## Version path

1. **v0.1** establishes the product vision and project-kernel boundary.
2. **v0.2** defines the core object model, bootstrap flow, and Runtime protocol.
3. **v0.3** adds Steward, Workflow, Agent, Workspace, Memory, Package, and
   governed-evolution profiles.
4. **v0.4** freezes the coordination record and action catalog into generated
   schemas and conformance fixtures.
5. **v0.5** implements the transactional local Runtime and CLI.
6. **v0.6** connects governed Steward intake and LPS Agent orchestration.
7. **v0.7** adds persistent Memory, Workflows, Profiles, and Packages and ships
   the first public Runtime Alpha.
8. **v0.8** adds digest-bound governed evolution with independent evaluation,
   monitoring, and rollback.
9. **v0.9** hardens compatibility, recovery, security, packaging, and release
   evidence and is folded into v1.0.
10. **v1.0** accepts the first stable compatibility inventory.
11. **v1.1** adds content-addressed RepositoryEvidence and reviewed sharing.
12. **v1.2** adds an explicit experimental Supervisor/Runner without changing
    stable authority or acceptance semantics.

## Reading paths

- Product readers: [product overview](../docs/product-overview.md),
  [framework overview](../docs/product-framework.md), then RFC 0000.
- Runtime implementers: RFCs 0001-0004, version specifications 0011-0018, the
  linked schemas, and the
  [architecture](../docs/architecture.md).
- Orchestration and Agent integrators: RFCs 0005-0010 and the
  [LPS integration guide](../docs/integrations/lps.md).
- Compatibility and release reviewers: the
  [v1 stable contract](../docs/release/v1-stable-contract.md),
  [contract inventory](../docs/release/v1-contract-manifest.json), and the
  relevant release notes under [`docs/release/`](../docs/release/).

## Changing a specification

Keep the document number and protocol version explicit. New machine claims need
matching schema and conformance coverage. Update this catalog whenever an RFC,
status, or companion artifact changes. A change enters the stable compatibility
promise only when the stable contract, machine inventory, release evidence, and
semantic-versioning decision are updated together.

Before submitting documentation changes, run:

```text
npm run check:links
npm run verify:schemas
npm run check:public-tree
```
