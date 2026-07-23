# Evidence and projections

The local reference Runtime stores authority in `.pkr/runtime.sqlite` and
rebuilds inspectable JSON under `.pkr/projections/`. Projection files are never
mutation input.

## Content-addressed repository evidence

RepositoryEvidence payloads are authoritative SQLite rows keyed by Project and
content digest. Runtime records, events, commands, and external-effect journal
entries retain small references instead of repeating Git diffs. The state
digest includes sorted stable references; each reference transitively binds the
raw payload through its content digest and canonical byte length.

Capture path and time remain reference observations and do not change stable
command identity. Resolution rechecks the digest, byte length, and summary.
Legacy inline evidence remains readable and projects as references without
silently rewriting old record revisions.

Local projections write each unique payload once under
`.pkr/projections/repository-evidence/`. Snapshots include those payloads and
restore them transactionally. Stores created by v1.0 migrate forward on open;
downgrade is rejected after content-addressed evidence is present because the
older format cannot represent the references safely.

## External sharing

Use the explicitly lossy sharing profile instead of copying local projections:

```powershell
pkr projection export --profile shareable --output .pkr/exports/pkr-state.shareable.json
```

The shareable profile replaces raw diffs, command stdout and stderr, absolute
paths, private prompts, and common secret fields with explicit notices. Raw
evidence notices retain content digests and byte counts; sensitive values and
paths do not. The default output budget is 1 MiB; `--max-bytes` must be explicit
for a larger reviewed export.

This deterministic profile reduces common disclosure risks but does not prove
that arbitrary Project text is safe to publish. Review the generated file
before external distribution. Raw evidence remains only in SQLite authority
and the local per-digest projection.
