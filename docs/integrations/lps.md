# LPS Agent-Native Orchestration

PKR assumes Codex, Claude, or another Agent has already loaded the repository.
LPS coordinates that current Agent through a pull loop; it does not need to
launch another Provider process. PKR SQLite remains authoritative and the LPS
board is rebuilt from current records and events.

## Default pull loop

1. `pkr lps claim --task <id> --agent <id>` creates or reuses an Assignment,
   AgentSession, Lease, and task-scoped Workspace.
2. The loaded Agent uses its existing repository and terminal tools to do the
   work directly.
3. `pkr lps submit --assignment <id> --agent <id>` collects current Git evidence
   and records an AgentMessage callback.
4. Submission releases the Lease and moves the Task only to `verifying`.
5. An independent Repository Verifier must recompute evidence before Runtime can
   create acceptance and move the Task to `done`.

`--session-locator` may correlate a PKR AgentSession with the current host
session, for example `codex://current-session`. The locator is stored as metadata
with `locatorIsIdentity=false` and `locatorIsAuthority=false`; the registered
Agent ID, capability statement, Assignment, and Lease remain the control facts.

## Mapping

| LPS concept | PKR source | Rule |
| --- | --- | --- |
| task tag | Task ID and revision | Task remains the delivery truth |
| session tag | AgentSession ID | host locator is not Agent identity |
| worker identity | Agent + Assignment + AgentSession | a locator alone grants no authority |
| current gate | active Assignment and Lease | work requires a live Lease |
| worker lifecycle | Assignment, Session, and Lease states | board state is derived |
| submission | AgentMessage plus Git evidence | submission cannot create acceptance |
| outcome `verified` | callback claim plus Verification | callback alone cannot complete Task |
| assurance state | Verification and Artifact records | missing evidence never means pass |
| board project sequence | latest Runtime event | stale boards cannot authorize commands |

## Worker state projection

- Assignment `running` -> LPS `active`;
- Assignment `submitted` -> LPS `waiting_verification`;
- Assignment `closed`, `cancelled`, or `rejected` -> LPS `archived`;
- Assignment `blocked`, `expired`, or `failed` -> LPS `blocked`.

The board contains `source.authority=PKR`, `projectId`, and `projectSequence`.
It is returned by `pkr lps board`; it is not persisted as a second truth file.

## Optional Adapter execution

`pkr lps adapter-run` retains the local stdio Provider path for background
Workers, remote Agents, and CI Agents. This path requires an explicit
`.pkr/provider.json`; `pkr doctor --adapter` checks its executable and active
Adapter binding. Adapter output is still a non-authoritative work report and
uses the same independent Verification gate.

The optional Adapter starts a trusted host process, sends a Workspace on stdin,
enforces timeout and output bounds, and records exit code, stdout, stderr, and
failure reason. It does not provide an OS filesystem or network sandbox.

## Failure and recovery

- cancellation revokes the Lease, closes the Session, and cancels the Task;
- Lease expiry expires Assignment and Session and blocks the Task;
- late submission after cancellation or expiry fails with `PKR-COORD-008`;
- heartbeat renews the current Lease through an idempotent Runtime command;
- a repeated submit for an already submitted Agent-native Assignment is a read
  of the existing state and creates no duplicate callback;
- restart reconstructs the board from SQLite records and event sequence.
