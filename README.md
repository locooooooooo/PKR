# PKR

PKR is a local, authoritative Runtime and AI Agent harness for governed
software development. It keeps project state in the target Git repository,
separates Agent work reports from acceptance, runs repository verification,
and recovers the audit trail after process restart.

The current candidate is `pkr-runtime@0.7.0-alpha.1` (npm dist-tag `alpha` is
reserved for a future authenticated publish). PKR v0.7 is a public alpha. The API is pre-stable, execution is local, and the
current Provider integration is the Codex CLI. Hosted deployment, cloud
Provider adapters, automatic model selection, and v0.8/v0.9 evolution features
are not part of this release.

## Install from source

The `pkr-runtime@0.7.0-alpha.1` package is **not currently published to npm**. Until an npm
release is completed, install the public Apache-2.0 source directly:

```shell
git clone https://github.com/locooooooooo/PKR.git
cd PKR
npm ci
npm run build
npm link
```

This requires Node.js 24 or newer, Git, and Python 3.11 or newer. `pkr run`
also requires an installed and authenticated `codex` CLI.

## Three-command path

Run these commands against the root of an existing Git repository:

```shell
pkr init --project /path/to/project --name my-project
pkr run "Add one bounded feature" --project /path/to/project --verify "npm test"
pkr status --project /path/to/project
```

`pkr init` creates `.pkr/runtime.sqlite` and rebuildable JSON projections inside
the target repository. `pkr run` records one governed Assignment, invokes the
local Codex CLI for the implementation step, then invokes the repository
Verifier for the declared command. `pkr status` opens the persisted state in a
fresh process and reports Tasks, Assignments, callbacks, and evidence.

The authority boundary is deliberate:

1. The Provider submits a non-authoritative work report and repository-change
   declaration. Even a callback that says `verified` cannot complete a Task.
2. The repository Verifier records structured process results and Git HEAD,
   status, diff, staged diff, and changed paths in digest-bound evidence.
3. The Runtime re-collects current Git evidence, recomputes the plan, scope,
   command, and final verdict, and only then creates test and acceptance
   Verification records.
4. A non-zero verification exit persists failed evidence and leaves the Task
   blocked. It never creates acceptance.

Provider and verification commands run as trusted host processes with the
current user's filesystem, network, and credential access. PKR enforces its
authority and evidence boundary, but v0.7 does **not** provide an OS sandbox.

## Reproducible proof

The checked-in [three-command demo](examples/three-command-demo/README.md)
creates a temporary Git repository, asks a real authenticated Codex CLI to make
one small change, verifies it, and reopens status in a fresh process:

```shell
npm run build
node scripts/run-three-command-demo.mjs
```

Automated tests use an explicitly fake Codex executable for deterministic CI;
they prove orchestration and trust-boundary behavior, not real model quality.
The real Codex demo is an optional local audit and is not run in CI.

## Validate the public tree

One canonical command runs generated-artifact checks, all Python conformance
validators, the Runtime tests, and the public alpha regressions:

```shell
npm run verify
npm run check:package
node scripts/check-public-tree.mjs
git diff --check
```

`npm run verify:schemas` selects Python 3.11 or newer on Windows and Linux. The
GitHub Actions workflow runs the same commands on both `ubuntu-latest` and
`windows-latest`.

The conformance runners check schema meta-models, valid fixtures for every core
and control-record kind, and targeted invalid fixtures. They do not claim to
prove authentication or all POM graph and lifecycle semantics.

## Operating model

- **PKR Kernel** owns authoritative state, permissions, policy, events,
  evidence, projections, and recovery semantics.
- **Project Steward** prepares governed intake and approval requests; it is not
  a root bypass.
- **LPS** plans, dispatches, monitors, and absorbs callbacks from PKR state
  without creating a second source of truth.
- **Provider adapters** translate external execution into proposals, results,
  logs, and artifact declarations. They do not issue acceptance.
- **Repository Verifier** executes the declared host command and gathers the
  Git and process evidence that Runtime acceptance requires.

The Runtime stores authority in `.pkr/runtime.sqlite`; files under
`.pkr/projections/` are inspectable, rebuildable outputs and never mutation
input. See [Decision 0001](docs/decisions/0001-reference-runtime-layout.md) and
the [LPS adapter mapping](docs/integrations/lps.md).

## Specification set

- [PKR v0.1 definition](specs/0000-pkr-v0.1.md)
- [PKR Object Model v0.2 draft](specs/0001-pkr-object-model-v0.2.md)
- [PKR Core Schema v0.2 draft](specs/0002-pkr-core-schema-v0.2.md)
- [PKR v0.2 JSON Schema](schemas/v0.2/pkr-object.schema.json)
- [PKR Manifest and Bootstrap v0.2 draft](specs/0003-pkr-manifest-bootstrap-v0.2.md)
- [PKR v0.2 Bootstrap Schema](schemas/v0.2/pkr-bootstrap.schema.json)
- [PKR Runtime Protocol v0.2 draft](specs/0004-pkr-runtime-protocol-v0.2.md)
- [PKR v0.2 Runtime Schema](schemas/v0.2/pkr-runtime.schema.json)
- [PKR Steward and LPS Boundary v0.3 draft](specs/0005-pkr-steward-lps-boundary-v0.3.md)
- [PKR Workflow and Verification Profile v0.3 draft](specs/0006-pkr-workflow-verification-v0.3.md)
- [PKR Agent Session Protocol v0.3 draft](specs/0007-pkr-agent-session-protocol-v0.3.md)
- [PKR Workspace and Memory v0.3 draft](specs/0008-pkr-workspace-memory-v0.3.md)
- [PKR Package and Governed Evolution v0.3 draft](specs/0009-pkr-package-evolution-v0.3.md)
- [PKR v0.4 Coordination Record and Action Catalog](specs/0010-pkr-v0.4-record-action-catalog.md)

This repository is the Apache-2.0 source and release tree for the v0.7 Runtime
and its specifications. It is not the obsolete spec-only staging repository.
