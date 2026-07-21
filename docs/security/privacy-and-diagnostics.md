# Privacy and diagnostics

PKR diagnostics are support summaries, not an audit-state export. Run:

```text
pkr diagnostics export --project <repository>
```

The command reads authoritative state but does not mutate it. It emits a
digest-derived project identity, Runtime phase, sequence, state digest, record
and phase counts, and at most 50 recent event type summaries.

It intentionally omits:

- project title and repository root;
- record IDs and record bodies;
- event IDs, command IDs, subject IDs, and event data;
- prompts, source content, diffs, callback bodies, and artifacts;
- Provider and Verification stdout/stderr.

The encoded report has a 64 KiB hard ceiling. Generic diagnostic values use
depth, list, key, and string bounds and redact recognized credential forms,
private-key blocks, bearer values, and user-home paths. Successful structured
Provider stdout is omitted before persistence. Failed Provider and Verification
process evidence keeps bounded redacted output, a basename-only executable,
redacted arguments, and a `[PROJECT-ROOT]` cwd marker.

Pattern redaction cannot determine whether arbitrary prose or source code is
private. Configured commands must not print credentials, prompts, full source,
or production diffs. Treat `.pkr/runtime.sqlite`, projections, work reports,
and raw verification evidence as project-private unless a separate export
policy authorizes them.

`npm run security:scan` builds the Runtime, scans the declared public working
tree, creates an actual npm tarball in a temporary directory, scans every text
entry, and deletes the tarball. It covers source, docs, examples, fixtures,
logs, generated package content, credential signatures, and private user-home
paths. The scanner reports rule and location but never echoes matched content.
