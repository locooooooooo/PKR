# Proposed v1 stable contract

- Target: `1.0.0`
- Current package: `0.7.0`, private, npm unpublished
- Contract status: `candidate_contract_unaccepted`
- Machine inventory: [v1-contract-manifest.json](v1-contract-manifest.json)

This is the complete candidate inventory required by G0. It is not an owner
Decision, a version bump, or a stable-release claim. `npm run check:contract`
compares the inventory with the current CLI routes, root TypeScript exports,
schema files, persisted record kinds, and literal Runtime event types.

## Stable candidate surfaces

The manifest lists every candidate-stable CLI route and TypeScript export by
name. The compatibility promise also includes:

- all nine versioned schemas under `schemas/v0.2/` and `schemas/v0.4/` at their
  current `$id` and `apiVersion` values;
- the listed SQLite record kinds and ordered event type names, including their
  revision, sequence, command, subject, and data semantics;
- `pkr.verify/v1` Verification plans and `pkr.preflight/v1` readiness reports;
- the `pkr` binary name, JSON stdout/error behavior, and route-specific CLI
  option contract;
- package root exports and `./package.json`; no deep internal import is stable.

SQLite tables, indexes, query plans, generated projections, LPS board layout,
private class members, and unexported modules are implementation details. A
physical SQLite migration may change those details only while preserving the
documented record/event semantics and supported migration path.

## Experimental surfaces

The manifest explicitly marks the following families experimental:

- `metric`, `prompt`, `policy`, `adapter`, and `evolution` CLI routes;
- `lps adapter-run` and the `pkr.provider/v1` local-process Provider contract;
- evolution, canary, managed Adapter, raw process, and direct store exports;
- `Metric` persistence and the listed adapter/evolution/metric/policy/prompt
  events.

Experimental surfaces are shipped for evaluation but are outside the v1
compatibility promise until G1 and G2 close. Their work reports remain
non-authoritative. They may never weaken Repository Verification or Runtime
acceptance semantics.

## Adapter contract boundary

The experimental `pkr.provider/v1` file declares Adapter identity, version,
capabilities, executable, structured arguments, timeout, and output bounds. A
Provider receives a scoped Workspace request on stdin and returns one bounded
callback on stdout. Provider-specific data must stay namespaced and cannot
alter Task, Verification, or acceptance semantics.

The current conformance evidence uses a checked-in fake Provider fixture. G2
still requires two heterogeneous Provider adapters and equivalent records and
acceptance behavior before this contract can become stable.

## Semantic-versioning policy

Before the target contract is accepted, `0.x` may break only with an explicit
compatibility note and migration rule. After `1.0.0`:

- patch releases may fix behavior without changing accepted CLI, TypeScript,
  schema, record, event, or adapter meaning;
- minor releases may add optional commands, fields, exports, schemas, records,
  or events while preserving existing valid inputs and persisted state;
- removing, renaming, retyping, or changing accepted semantics requires a new
  major version and a documented migration path;
- adding a required field, rejecting previously valid input, changing a CLI
  exit/status contract, or changing persisted replay meaning is breaking;
- experimental surfaces may change before promotion, but every change must be
  labeled and may not silently reinterpret existing authoritative state.

Schema filenames and their internal API versions do not need to equal the npm
package version. The version manifest is the binding between them.

## Supported environment

| Surface | Candidate support |
| --- | --- |
| Node.js | 24.x only |
| Operating systems | GitHub `windows-latest` and `ubuntu-latest` |
| Python conformance | Python 3.11 |
| Repository | Git repository accessible to the current OS user |
| macOS, Node 25+, other Linux distributions | Not declared for v1 |
| Security boundary | Trusted host process; no OS sandbox or production SLA |

The matrix is a proposed contract until the exact public candidate completes
CI and the owner accepts G0.
