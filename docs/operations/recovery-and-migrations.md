# Recovery, Retention, and Store Migrations

PKR recovery preserves four separate claims:

1. SQLite records and events are authoritative project state.
2. a participant work report describes attempted work but creates no acceptance;
3. Repository Verification recomputes repository evidence independently;
4. Runtime acceptance is a later authoritative transition.

Recovery never promotes one claim into another.

## Interrupted execution

`PkrRuntime.open()` compares active Session and Lease expiry timestamps with the
current time. An elapsed execution is closed in one SQLite transaction:

- Lease becomes `expired`;
- Assignment becomes `expired`;
- AgentSession becomes `expired`;
- Task becomes `blocked` with reason `LeaseExpired`;
- the execution WorkflowRun becomes `blocked`.

An explicit reassignment can then create a new Assignment, Session, Lease, and
WorkflowRun for the same Task. PKR rejects reassignment while any prior
Assignment or Lease remains live. A callback from the old Assignment is also
rejected because its Lease is no longer live.

## External effect fence

Optional integration-process execution is fenced by a stable effect ID in SQLite.
The journal state is one of `pending`, `succeeded`, or `failed`:

- a terminal entry replays its persisted result without executing the process
  again;
- a `pending` entry means the process may have run but PKR did not durably
  observe its result;
- PKR fails closed on `pending`, and also blocks reassignment when a terminal
  successful effect was not absorbed before its Assignment expired;
- explicit reconciliation is required before any retry whose safety PKR cannot
  prove from the journal.

This is duplicate-effect protection, not proof that an arbitrary external
system implements idempotency. Integration-process output remains
non-authoritative and still needs Repository Verification and Runtime
acceptance.

## Snapshot and restore

`PkrRuntime.createSnapshot(path)` writes a canonical JSON snapshot through a
temporary file and atomic rename. It contains:

- current records and their revisions;
- the complete logical event history;
- committed command digests and replay results;
- external effect journal entries;
- the active retention policy;
- project sequence, logical state digest, and a snapshot checksum.

`PkrRuntime.restore(snapshot, projectRoot, repositoryRoot)` only restores into a
path with no existing SQLite authority. It verifies the checksum before writing
and compares the restored logical state digest before opening the Runtime.
Corrupt, partial, unsupported, or stale-overwrite attempts fail explicitly.

## Compaction and retention

The only supported policy is currently:

```json
{
  "keepRecentEvents": 100,
  "auditGuarantee": "full-replay"
}
```

Compaction moves older events into immutable, digest-checked SQLite archive
rows. It does not delete logical history. `listEvents()`, snapshots, replay
digests, and audit reads still return a contiguous history beginning at
sequence 1. A policy that requests destructive retention or keeps no live event
is unsupported and fails.

## Migration matrix

| Source | Target | Support | Conditions and failure behavior |
| --- | --- | --- | --- |
| `pkr.store/v0.7.0-alpha.1` | `pkr.store/v1-candidate` | supported, automatic | Exact public-alpha `metadata`, `records`, `events`, and `commands` layout; validates JSON, project cardinality, contiguous sequence, and metadata before one transactional migration. |
| `pkr.store/v1-candidate` | `pkr.store/v1-candidate` | supported | Format marker, SQLite `user_version`, required tables, archive digests, and logical sequence must agree. |
| `pkr.store/v1-candidate` | `pkr.store/v0.7.0-alpha.1` | supported, bounded export | Only when the effect journal and compaction archive are empty. Otherwise downgrade fails because alpha cannot preserve those claims. |
| snapshot `pkr.snapshot/v1` | `pkr.store/v1-candidate` | supported | Checksum, shape, empty target, project sequence, and final state digest must pass. |
| unknown marker or version | any | unsupported | Fails with `PKR-MIGRATION-001`. |
| missing core/candidate tables | any | unsupported partial state | Fails with `PKR-MIGRATION-002`. |
| inconsistent sequence or multiple project authorities | any | stale state | Fails with `PKR-MIGRATION-003`. |
| invalid SQLite or stored JSON | any | corrupt state | Fails with `PKR-MIGRATION-004`. |

The public alpha is identified structurally because that release did not store
a format marker. A database containing a mixture of unmarked alpha tables and
candidate-only tables is treated as partial, not guessed into a version.

## Verification

Run the focused recovery suite:

```powershell
npm run test:recovery
```

Run the repository-wide verification gate:

```powershell
npm run verify
```

The focused suite uses a clearly labeled process fixture only for effect
counting. It does not claim evidence from a live integration, user, sandbox,
performance environment, security review, or production deployment.
