# Changelog

All notable public changes are recorded here. PKR follows semantic versioning
for the accepted v1 stable contract.

## Unreleased

- Added public version specifications for v0.5 through v1.2, including the
  release status and compatibility role of every milestone after v0.4.

## 1.2.0 - 2026-07-23

- Added an experimental, explicitly configured Provider-neutral Supervisor
  with deterministic `--once` / `--watch` reconciliation, restart-safe
  Provider and Verification effect fencing, and fail-closed Owner attention.
- Kept SQLite as the sole Runtime authority and independent Repository
  Verification as the only path to acceptance; Skill metadata and Provider
  reports remain non-authoritative.
- Kept the npm package private and unpublished; v1.2.0 remains a GitHub source
  release and does not authorize `npm publish`.

## 1.1.0 - 2026-07-23

- Stored repeated RepositoryEvidence payloads once in content-addressed SQLite
  authority while Sessions, Messages, Artifacts, commands, and external-effect
  journals retain digest-bound references.
- Added a transactional v1.0-to-v1.1 store migration, evidence-aware snapshots
  and restore, fail-closed downgrade behavior, and legacy inline compatibility.
- Added `pkr projection export --profile shareable` with deterministic
  redaction and an explicit output-size budget for reviewed external sharing.
- Kept the npm package private and unpublished; v1.1.0 remains a GitHub source
  release and does not authorize `npm publish`.

## 1.0.0 - 2026-07-22

- Established PKR as an AI-native project framework and local Runtime with
  SQLite-authoritative project state, governed work, independent Repository
  Verification, separate Runtime acceptance, recovery, Memory, and audit.
- Accepted the stable CLI, TypeScript, schema, record, event, support, and
  semantic-versioning contract while keeping declared integration and evolution
  surfaces experimental.
- Added reproducible source installation, newcomer, lifecycle, recovery,
  security, package, benchmark, soak, and Windows/Ubuntu CI evidence.
- Adopted Apache-2.0 with NOTICE and third-party notices.
- Kept the npm package private and unpublished; v1.0.0 is a GitHub source
  release and does not authorize `npm publish`.

## 0.7.0-alpha.1

- Published the runtime-bearing public alpha as a prerelease.
- This prerelease is not a stable contract and is not published to npm.
