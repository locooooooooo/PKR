# Changelog

## Unreleased

- Clarified the public product position, authority boundaries, and current
  non-goals in the README and product overview.
- Added a `--case blocked` three-command demo that proves failed verification,
  durable blocked state, and fresh-process recovery.
- Recorded the optional real-Codex audit separately from the tagged release.

## 0.7.0-alpha.1 - 2026-07-19

- Public alpha of the local PKR Runtime for the Codex CLI.
- Added the supported `pkr init`, `pkr run`, and `pkr status` path with
  persistent SQLite authority and restart-readable status.
- Separated Provider work reports from independent Repository Verification and
  Runtime acceptance; failed checks remain blocked with durable evidence.
- Added the three-command demo, fake-Codex CI coverage, and Windows adapter
  recovery notes.
- Published the GitHub prerelease and tag `v0.7.0-alpha.1`.

### Explicitly not released

- The npm package is not published; source installation is required.
- No OS sandbox, hosted deployment, cloud Provider adapters, automatic model
  selection, production stability guarantee, or v0.8/v0.9 evolution feature is
  included.
