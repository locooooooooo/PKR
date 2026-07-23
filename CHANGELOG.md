# Changelog

All notable public changes are recorded here. PKR follows semantic versioning
for the accepted v1 stable contract.

## Unreleased

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
