# PKR Package and Governed Evolution v0.3

- Status: Draft
- Index: [PKR specification index](README.md)
- Scope: Package compatibility, installation, and controlled self-improvement
- Depends on: [PKR Object Model v0.2](0001-pkr-object-model-v0.2.md)
- Workflow policy: [PKR Workflow and Verification Profile v0.3](0006-pkr-workflow-verification-v0.3.md)
- Memory promotion: [PKR Workspace and Memory v0.3](0008-pkr-workspace-memory-v0.3.md)

## 1. Purpose

This RFC defines how independently developed Packages extend a PKR Project and
how the Project may improve its prompts, policies, Workflows, adapters, and
Packages without silently changing authority, weakening core invariants, or
destroying rollback history.

## 2. Package identity

A `PackageManifest` is a Runtime control record, not a POM core object. It
contains:

- globally unique reverse-domain or URI package ID;
- semantic package version and immutable content digest;
- publisher identity and optional signature metadata;
- supported PKR API and schema version ranges;
- dependencies and conflicts;
- contributed schemas, relations, predicates, Workflows, Roles, Constraints,
  Verification policies, adapters, templates, and project profiles;
- requested host capabilities and permission ceilings;
- install, migration, uninstall, and rollback declarations;
- license and source or distribution metadata.

Package ID and version identify behavior. Reusing a published version with
different content MUST fail.

## 3. Package contributions

A Package MAY:

- add namespaced fields under POM `extensions`;
- add namespaced relation and pure predicate definitions;
- contribute Workflow, Role, Constraint, Verification, Metric, Knowledge, and
  object templates;
- contribute evidence, tool, Agent, Memory, or orchestration adapters;
- provide project bootstrap profiles consumed after core bootstrap;
- add stricter validation and additional gates.

A Package MUST NOT:

- redefine core fields, kinds, phases, relations, or error semantics;
- weaken core identity, authorization, provenance, completion, or event rules;
- create an unnamespaced core object kind;
- execute undeclared install or Runtime capabilities;
- treat package storage as independent project truth;
- delete historical events or provenance when disabled or uninstalled.

## 4. Package installation record

One installed version is represented by `PackageInstallation`, a versioned
Runtime control record with:

- Project, package ID, version, digest, and installation ID;
- resolved dependency graph and exact versions;
- approved capabilities and permission ceiling;
- active contribution IDs and schema versions;
- lifecycle state and revision;
- installing principal, Decision, Workflow, command, and event references;
- migration, health, and rollback status.

Lifecycle:

```text
proposed -> resolving -> staged -> active -> suspended -> uninstalled
    |          |           |         |
    +----------+-----------+--------> failed
                         active ----> superseded
```

`uninstalled`, `failed`, and `superseded` preserve the installation record and
all historical contribution identities.

### 4.1 Logical Runtime operations

The Package control surface exposes:

| Operation | Purpose | Mutation |
| --- | --- | --- |
| `proposePackageInstall(manifest)` | Create a governed installation proposal | yes |
| `resolvePackageInstall(installation)` | Resolve compatibility, dependencies, and capabilities | yes |
| `stagePackageInstall(installation)` | Validate contributions and prepare migration and rollback | yes |
| `activatePackageInstall(installation)` | Atomically activate a verified staged version | yes |
| `suspendPackageInstall(installation)` | Disable active contributions without erasing history | yes |
| `uninstallPackage(installation)` | Remove active contributions under uninstall policy | yes |
| `rollbackPackage(installation, target)` | Restore a declared prior active version | yes |
| `getPackageInstallation(projectId, id, selector)` | Read one installation revision | no |
| `listPackageInstallations(projectId, query)` | Read a sequence-bound collection | no |

Every mutation is authenticated, authorized by Role and Workflow, uses an exact
expected revision and decision basis, emits events, and returns a Runtime-style
result. Machine-readable action envelopes are deferred to v0.4.

## 5. Resolution and activation

Before activation, the Runtime must:

1. authenticate the installing principal;
2. verify package identity, digest, compatibility, and available signature;
3. resolve dependencies and conflicts deterministically;
4. compare requested capabilities with host and project policy;
5. validate every contribution namespace and schema;
6. prove that added validation does not weaken the core;
7. stage migrations and build a rollback plan;
8. run required package and project Verification;
9. obtain the material Decision or approval required by policy;
10. atomically activate the installation and emit events.

Activation failure leaves the previous active contribution set unchanged.

## 6. Project profiles

A project profile is a Package contribution that proposes a coherent starter
set of Roles, Workflows, Constraints, Verification policies, Knowledge, and
templates for a project class such as web, desktop, game, service, or library.

Core bootstrap still creates only the Manifest, Mission, Owner Role, and
Governance Workflow defined by the Bootstrap RFC. Profile installation is a
separate post-bootstrap governed transaction so a profile cannot become a
hidden genesis authority.

## 7. Evolution inputs

Evolution may be proposed from:

- repeated failed or blocked Assignments;
- assurance debt or Verification trends;
- Metric threshold breaches;
- Issues and human feedback;
- successful execution patterns promoted from Memory;
- package security or compatibility notices;
- explicit human or Agent proposals.

Observation alone never changes active behavior.

## 8. Governed evolution loop

```text
observe
  -> create Issue and evidence
  -> propose bounded change
  -> classify materiality and risk
  -> create or resolve Decision
  -> implement in isolated candidate version
  -> verify in sandbox or canary
  -> approve promotion
  -> activate or roll back
  -> monitor and retain provenance
```

The proposal identifies the target component and exact active version, problem
evidence, expected improvement, non-goals, changed permissions or invariants,
test and canary plan, promotion gate, rollback target, and expiry.

## 9. Evolution targets

Governed evolution may target:

- Knowledge or prompt Artifacts;
- Workflow definitions and verification policies;
- Role permissions or separation rules;
- Agent, tool, evidence, Memory, or LPS adapters;
- Package versions and project profiles;
- reference Runtime implementation;
- conformance fixtures and compatibility declarations.

Changes to architecture, public contracts, security, compatibility, active
Constraints, budgets, deadlines, or release policy require an accepted Decision
under the Object Model.

## 10. Separation of duties

For a material evolution, project policy SHOULD separate:

- proposer;
- implementation executor;
- Verification executor;
- approving principal;
- promotion principal.

One Agent MUST NOT unilaterally propose, approve, verify, and activate a change
that expands its own permissions, removes its gates, alters audit retention, or
weakens rollback. A human approval is REQUIRED for changes to genesis authority,
owner permissions, credential policy, public release authority, or the core
invariant boundary.

## 11. Sandbox, canary, and promotion

A candidate version receives a distinct immutable identity and digest. Sandbox
or canary execution uses declared input sets, protected output scope, time and
cost budgets, success metrics, and abort conditions.

Promotion requires:

- all required Verification attempts applicable to the candidate digest;
- success criteria and regression limits satisfied;
- no active unwaived blocker;
- compatible migration and tested rollback;
- authorized approval at the latest relevant project sequence;
- one atomic active-version switch and attributable event range.

A canary result cannot be reused after the candidate content changes.

## 12. Rollback and history

Rollback changes the active version pointer or installation state. It does not
rewrite Decisions, candidate Artifacts, failed attempts, events, or prior
installation records.

Automatic rollback is permitted only when an active Workflow declares the
trigger, protected scope, target version, and authority in advance. Otherwise
the Runtime pauses the protected action and requests approval.

## 13. Runtime self-update boundary

A Runtime implementation may participate in its own upgrade only through an
external supervisor capable of preserving the current trusted version,
validating the candidate, switching atomically, and restoring the prior version
after startup failure.

An in-process model or Agent cannot replace the binary or policy evaluator that
is currently authorizing it without that external boundary.

## 14. Conformance

A conforming implementation must prove that:

1. package version and digest cannot be reused inconsistently;
2. dependency and conflict resolution is deterministic;
3. unknown or excessive capabilities fail before activation;
4. package validation cannot weaken core invariants;
5. failed installation leaves the prior active set unchanged;
6. observed behavior creates proposals, not silent active changes;
7. material self-permission changes require separated approval;
8. candidate changes invalidate prior candidate-specific evidence;
9. promotion and rollback preserve complete history and provenance;
10. uninstall leaves historical objects, events, and Artifacts resolvable.

## 15. Deferred work

Machine-readable Package schemas, registry discovery, publisher trust roots,
signature format, vulnerability feeds, dependency solver choice, binary
sandboxing, hosted marketplaces, commercial licensing enforcement, and
cross-project learning are deferred.
