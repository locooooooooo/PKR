# LPS Reference Adapter

The PKR reference Runtime includes an LPS-compatible orchestration adapter. PKR
remains the authority; the LPS board is rebuilt from current records and events.

## Mapping

| LPS concept | PKR source | Rule |
| --- | --- | --- |
| task tag | Task ID and revision | Task remains the delivery truth |
| session tag | AgentSession ID | provider locator is not Agent identity |
| worker identity | Agent + Assignment + AgentSession | one thread alone grants no authority |
| current gate | active Assignment and Lease | execution requires a live Lease |
| worker lifecycle | Assignment, Session, and Lease states | board state is derived |
| callback package | AgentMessage callback payload | Runtime validates before absorption |
| outcome `verified` | non-authoritative Provider claim | callback alone cannot complete Task |
| assurance state | Verification and Artifact records | missing evidence never means pass |
| board project sequence | latest Runtime event | stale boards cannot authorize commands |

## Worker state projection

- Assignment `running` -> LPS `active`;
- Assignment `submitted` -> LPS `waiting_verification` for a successful work
  report, otherwise `blocked`;
- Assignment `closed`, `cancelled`, or `rejected` -> LPS `archived`;
- Assignment `blocked`, `expired`, or `failed` -> LPS `blocked`.

The projection contains `source.authority=PKR`, `projectId`, and
`projectSequence`. It is returned by `pkr lps board`; it is not persisted as a
second truth file.

## Dispatch and callback

`pkr lps run`:

1. checks provider capabilities;
2. reuses or creates one idempotent Assignment;
3. reads the Session and Lease committed by the Runtime;
4. builds a sequence-bound Workspace;
5. invokes the provider adapter;
6. commits the callback AgentMessage;
7. leaves a successful Provider result at the `verifying` gate;
8. requires a distinct repository Verifier and Runtime-validated evidence
   before closing Assignment, Session, and WorkflowRun.

Duplicate execution requests for a closed Task return the existing Assignment
without invoking the provider again. A terminal failed or cancelled Assignment
requires an explicit replacement or recovery path.

## Failure behavior

- provider timeout leaves the Assignment visible as `running`; an owner or LPS
  recovery action must cancel, expire, or resume it;
- cancellation revokes the Lease, closes the Session, and cancels the Task;
- Lease expiry expires Assignment and Session and blocks the Task;
- late callback after cancellation or expiry fails with `PKR-COORD-008`;
- heartbeat renews the current Lease through an idempotent Runtime command;
- restart reconstructs the board from SQLite records and event sequence.

## Provider boundary

v0.6 proves one real local process adapter. It starts a separate process, sends
an actual Workspace over stdin, enforces a timeout, and parses a callback from
stdout. v0.7 adds one local Codex CLI adapter. Cloud-model integrations and
Claude or Gemini adapters remain outside the public v0.7 boundary.

The Codex CLI and verification command are trusted host processes. A separate
process is not by itself an independent trust boundary: v0.7 relies on the
Runtime re-collecting Git evidence and recomputing the submitted verdict. PKR
does not provide an OS sandbox for Provider or Verifier commands.
