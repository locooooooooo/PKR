# PKR v1 owner review

Use this checklist only after one immutable public candidate has passed every
technical gate in the [candidate checklist](v1.0-candidate-checklist.md). Record
the candidate SHA and CI URL before making a decision.

- Candidate SHA:
- Public CI:
- Reviewer:
- Decision date:

## Required decisions

### Stable contract

- [ ] Accept the CLI, TypeScript, schema, record, event, support, and
  experimental-surface boundaries in the [v1 stable contract](v1-stable-contract.md).
- [ ] Reject and identify the exact contract item that must change.

Acceptance means future 1.x releases preserve the listed stable semantics. It
does not make experimental Adapter, evolution, or direct-store surfaces stable.

### Governed evolution

- [ ] Accept the integrated v0.8 success, failed-candidate, promotion,
  rejection, monitoring, and rollback evidence for inclusion in the candidate.
- [ ] Reject and identify the missing or unacceptable evidence.

Acceptance permits the candidate to ship these capabilities under the declared
stable or experimental classifications. It does not authorize autonomous
self-approval or unrestricted self-modification.

### Trusted-host risk

- [ ] Accept the documented trusted-host boundary and the absence of an OS
  sandbox for this local Runtime release.
- [ ] Reject and identify the additional security control or audit required.

Configured executables run with the current operating-system user's authority.
PKR supplies policy, evidence, bounds, and fail-closed Runtime transitions, not
filesystem or network isolation.

### License

- [ ] Accept Apache-2.0, NOTICE, and the third-party notices for the public
  source release.
- [ ] Reject and identify the required license or notice change.

### Hidden blockers

- [ ] Confirm that every known blocker is present in the
  [blocker register](v1.0-blockers.md) and no hidden release blocker remains.
- [ ] Reject and record each newly discovered blocker.

## Release authorization

Completing individual decisions does not by itself publish anything. After all
required decisions are accepted, a separate explicit authorization is still
required for the version change, merge to public main, v1.0.0 tag, and GitHub
Release. npm publication remains a separate optional transaction.
