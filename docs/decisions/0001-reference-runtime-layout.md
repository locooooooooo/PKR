# Decision 0001: Reference Runtime Layout and Storage

- Status: Accepted for v0.5
- Scope: Local reference Runtime only
- Decision owner: PKR development repository

## Question

How should the first reference Runtime prove atomicity, recovery, and dependency
direction without prematurely publishing unstable package boundaries?

## Decision

Use one private TypeScript npm package with machine-checked source-module
boundaries:

```text
types / errors / util
  -> contracts / objects / store
  -> projection
  -> runtime
  -> cli
```

Use Node 24 `node:sqlite` as the local authoritative store with `WAL`,
`synchronous=FULL`, foreign-key enforcement, and `BEGIN IMMEDIATE` command
transactions. Store command idempotency results, current records, and ordered
events in the same database transaction.

Write deterministic JSON files only under `.pkr/projections/`. Projection files
are rebuilt from SQLite and are never accepted as mutation input.

## Reasons

- SQLite supplies a measurable atomic commit boundary and restart behavior.
- A single private package avoids creating public compatibility promises before
  the API reaches a candidate state.
- The boundary checker provides an enforceable dependency direction now and can
  guide later package extraction without changing behavior.
- Node's built-in SQLite avoids native third-party build dependencies on the
  supported Windows environment.

## Alternatives

- Direct JSON or YAML authority was rejected because multi-record atomicity,
  concurrency, and crash recovery would require a custom journal.
- Multiple publishable workspace packages were deferred because their public
  dependency surfaces are not stable in v0.5.
- A hosted database was rejected because the first golden path must work
  offline in one local project.

## Consequences

- Node 24 or newer is required for the current reference implementation.
- `node:sqlite` still reports an experimental warning in Node 24; this is a
  runtime dependency risk to revisit before `1.0`.
- Package extraction remains possible when module APIs stabilize.
- Distributed consensus, remote storage, and multi-project transactions remain
  outside v0.5.

## Verification

- `npm run check:boundaries` rejects reverse or undeclared module imports.
- Runtime tests prove restart identity, idempotency, stale-write rejection,
  failpoint rollback, projection rebuild, and one-process-per-command CLI use.
