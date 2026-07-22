# Operational limits

These are v1 local Runtime limits, not production SLA targets.

| Surface | Limit | Failure behavior |
| --- | --- | --- |
| Configured integration or Verification timeout | 100 ms to 600,000 ms | config rejected outside range; elapsed child is force-terminated and marked `TimedOut` |
| Direct bounded process timeout | 1 ms to 600,000 ms | call rejected outside range |
| Process input | 2 MiB hard maximum | process is not spawned; `InputLimitExceeded` |
| Retained stdout plus stderr | 256 KiB default; 1 MiB hard configurable maximum | only bytes within the cap are retained; process is terminated with `OutputLimitExceeded` and `outputTruncated=true` |
| Git evidence command | 30 s and 512 KiB per invocation | Repository Verification fails explicitly |
| Command arguments | 128 arguments; 64 KiB per argument | integration config or Verification plan rejected |
| Callback JSON | 256 KiB encoded; 128 entries per list; 4 KiB per string; 2 KiB locator | callback rejected before authoritative mutation |
| Diagnostic export | 64 KiB; 50 event summaries; no record/event bodies | export fails rather than emitting an oversized report |
| Sensitive-data scan | 2 MiB per text file; 32 MiB expanded tar; 10,000 tar files | finding or explicit scan error; archive is not partially accepted |
| SQLite writer wait | 5,000 ms busy timeout | command fails; no inferred success |

## Retention

PKR currently performs no automatic deletion or compaction of authoritative
records, events, commands, Decisions, Verification, or acceptance evidence.
They remain in `.pkr/runtime.sqlite`; projections are disposable and
rebuildable. There is no supported public snapshot/restore or retention-policy
CLI yet. The G6 benchmark's restore measurement copies a closed test fixture's
`.pkr` snapshot, opens it, and compares the state digest. That measurement is
not a G3 operational restore guarantee.

Long histories increase status digest and full projection rebuild cost. Use the
benchmark and soak scripts on the intended supported environment. Production
retention, compaction, backup encryption, secure deletion, recovery point,
recovery time, and SLA targets remain explicit release blockers.
