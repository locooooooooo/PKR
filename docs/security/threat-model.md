# PKR threat model

Status: local security baseline for the pre-stable Runtime. This model does not
claim penetration testing, an external audit, an OS sandbox, or production
security certification.

## Security boundary

SQLite `.pkr/runtime.sqlite` is authoritative project state. Projections are
derived. Provider and Agent work reports are non-authoritative. Repository
Verification recomputes live Git evidence, and Runtime acceptance is a separate
transition.

PKR, configured commands, local Adapters, Agents, and repositories run with the
current operating-system user's permissions. They are trusted host inputs. PKR
applies policy, evidence, scope, timeout, and size controls; it does not isolate
them from the host filesystem, process table, credentials, or network.

## Assets

- authoritative Runtime records, events, Decisions, and acceptance history;
- repository source, diffs, artifacts, prompts, and project metadata;
- credentials available to the current host process;
- integrity of configured verification and Provider commands;
- availability of the Runtime, SQLite state, and derived projections.

## Threats and controls

| Threat | Trust assumption and attack | Current controls | Executable evidence | Residual risk |
| --- | --- | --- | --- | --- |
| Trusted host process | A configured executable can read, write, spawn, or use the network with user authority. | Explicit configuration, argument arrays without a shell, capability declarations, timeout/output bounds, process audit summary. | process limit and redaction tests | No OS sandbox; a trusted process or descendant can damage the host. |
| Command execution | A verifier or Adapter hangs, floods output, embeds secrets in arguments, or exits ambiguously. | 600 s hard timeout ceiling, aggregate output hard cap, 2 MiB input cap, forced child termination, structured exit/failure reason, persisted argument/log redaction. | `security.test.ts`; verification and Provider lifecycle tests | Descendant process-tree containment and network denial are not provided. |
| Repository mutation and path escape | Relative traversal, absolute paths, symlink, or junction writes escape the Git root. | Output locator validation, canonical Git-root comparison, repository-relative segment checks, and symlink/junction rejection in the built-in worker. | path-safety and locator regressions | An arbitrary trusted Adapter executable still has host authority and can ignore PKR helpers. |
| Callback forgery | A worker claims success, replays stale evidence, changes a callback after evaluation, or marks work accepted. | Callback shape/size limits, active Lease and Adapter digest checks, idempotency, live Repository Verification, different verifier identity, separate acceptance transition. | callback forgery, stale callback, Adapter rollback, and Repository Verification tests | External Provider identity/authentication requires adapter-specific review. |
| Secret exposure | Credentials, private paths, prompts, diffs, or process output enter logs, diagnostics, fixtures, source, or tarballs. | Successful Provider stdout omission, process diagnostic redaction, bounded summary-only diagnostics, public-tree and real-tarball scanner, package test-output exclusion. | security scanner regressions and `npm pack` scan | Redaction is pattern-based; arbitrary sensitive project prose cannot be classified reliably. Trusted commands must avoid printing it. |
| Malicious repository content | Large files, crafted names, hostile scripts, or untrusted verification configuration trigger execution or resource use. | Git evidence output caps, strict relative path rules, bounded JSON/callback/file scans, verification plan validation; no command is inferred from repository content. | scope, command failure, path, and scanner tests | Running repository-provided commands means trusting them. No malware scanner or content sandbox is included. |
| Denial of service | Huge input/output, event history, repeated restarts, SQLite contention, or archive expansion consumes resources. | Hard process, callback, diagnostic, archive, and scan bounds; SQLite busy timeout; explicit failures; reproducible long-history/restart soak. | process bounds, benchmark, and soak scripts | No multi-tenant quotas, process-tree cgroup/job limits, or production SLA. |

## Required external decisions

G5 cannot be accepted solely from this repository. The Project owner must
accept the trusted-host residual risk. Independent penetration review and an
external security/privacy audit remain release blockers if required for the
stable candidate.
