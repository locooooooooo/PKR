# PKR v1 stable contract

- Version: `1.1.0` (backward-compatible extension of `1.0.0`)
- Package: private, npm unpublished
- Contract status: `stable_contract_accepted`
- Accepted by: `xjf` on 2026-07-23
- Machine inventory: [v1-contract-manifest.json](v1-contract-manifest.json)

This is the accepted inventory required by G0. `npm run check:contract`
compares it with the current CLI routes, root TypeScript exports, schema files,
persisted record kinds, and literal Runtime event types.

## Stable v1 surfaces

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
- `lps adapter-run` and the legacy-named `pkr.provider/v1` local-process Adapter
  contract;
- evolution, canary, managed Adapter, raw process, and direct store exports;
- `Metric` persistence and the listed adapter/evolution/metric/policy/prompt
  events.

Experimental surfaces are shipped for evaluation but are outside the v1
compatibility promise. Their work reports remain non-authoritative. They may
never weaken Repository Verification or Runtime acceptance semantics, and any
later promotion requires its own compatibility decision and evidence.

## Adapter contract boundary

The current source retains `pkr.provider/v1` and related `Provider` identifiers
as compatibility names for an experimental local-process Adapter. That file
declares Adapter identity, version, capabilities, executable, structured
arguments, timeout, and output bounds. The configured process receives a
scoped Workspace request on stdin and returns one bounded callback on stdout.
Integration-specific data must stay namespaced and cannot alter Task,
Verification, or acceptance semantics.

This optional Adapter is not part of the v1 stable compatibility promise. The
default Agent-native claim/submit path does not load it. Fixture conformance
proves only the experimental process boundary; PKR v1 does not require live AI
service compatibility evidence unless a separate integration makes that claim.

## Semantic-versioning policy

The accepted v1 contract follows these rules:

- patch releases may fix behavior without changing accepted CLI, TypeScript,
  schema, record, or event meaning;
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

| Surface | v1 support |
| --- | --- |
| Node.js | 24.x only |
| Operating systems | GitHub `windows-latest` and `ubuntu-latest` |
| Python conformance | Python 3.11 |
| Repository | Git repository accessible to the current OS user |
| macOS, Node 25+, other Linux distributions | Not declared for v1 |
| Security boundary | Trusted host process; no OS sandbox or production SLA |

Reviewer `xjf` accepted this matrix on 2026-07-22 after the exact public
candidate completed Windows and Ubuntu CI.
