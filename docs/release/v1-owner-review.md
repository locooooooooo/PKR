# PKR v1 owner review

This record captures the owner decisions made after one immutable public
candidate passed every technical gate in the
[release checklist](v1.0-candidate-checklist.md).

- Evidence candidate SHA: `b2b33a1e86636dcd78ea92a60dd15e55f9b065cc`
- Public CI: https://github.com/locooooooooo/PKR/actions/runs/29896964548
- PR CI: https://github.com/locooooooooo/PKR/actions/runs/29897920412
- Reviewer: `xjf`
- Decision date: 2026-07-22

## Required decisions

### Stable contract

- [x] Accept the CLI, TypeScript, schema, record, event, support, and
  experimental-surface boundaries in the [v1 stable contract](v1-stable-contract.md).

Acceptance means future 1.x releases preserve the listed stable semantics. It
does not make experimental Adapter, evolution, or direct-store surfaces stable.

### Governed evolution

- [x] Accept the integrated v0.8 success, failed-candidate, promotion,
  rejection, monitoring, and rollback evidence for inclusion in the candidate.

Acceptance permits the candidate to ship these capabilities under the declared
stable or experimental classifications. It does not authorize autonomous
self-approval or unrestricted self-modification.

### Trusted-host risk

- [x] Accept the documented trusted-host boundary and the absence of an OS
  sandbox for this local Runtime release.

Configured executables run with the current operating-system user's authority.
PKR supplies policy, evidence, bounds, and fail-closed Runtime transitions, not
filesystem or network isolation.

### License

- [x] Accept Apache-2.0, NOTICE, and the third-party notices for the public
  source release.

### Hidden blockers

- [x] Confirm that every known blocker is present in the
  [blocker register](v1.0-blockers.md) and no hidden release blocker remains.

## Release authorization

Reviewer `xjf` separately authorized G10 on 2026-07-22 for the version change,
merge to public `main`, `v1.0.0` tag, and GitHub Release. npm publication was
explicitly not authorized and remains outside this transaction.
