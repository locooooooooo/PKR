# Security policy

PKR v1 is a stable local Runtime contract, not a hardened isolation boundary or
production security certification.

## Trust boundary

PKR runs locally with the permissions of the current operating-system user.
The CLI, configured Verification commands, local-process Adapters, integration
executables, and repositories they inspect must be trusted. Process timeouts,
structured argument arrays, capability declarations, digests, scopes, and audit
records constrain and explain execution, but they do not provide an OS-level
filesystem, process, credential, or network sandbox. Do not use PKR to execute
untrusted code or point an Adapter at an untrusted executable.

The SQLite database at `.pkr/runtime.sqlite` is authoritative project state.
Projections and orchestration views are derived. Agent results and integration
callbacks cannot create acceptance; independent Verification must recompute
evidence from the live repository.

Do not place API keys, credentials, private prompts, production source diffs,
runtime databases, or sensitive integration output in the repository, logs, or
public reports.

## Reporting a vulnerability

Report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/locooooooooo/PKR/security/advisories/new)
before any public discussion. Include the affected version or commit, a minimal
reproduction, impact, and whether the report involves authoritative state,
Verification, an Adapter, an integration process, or the CLI.

If GitHub does not show the private reporting form for your account, do not put
credentials, exploit details, private source, or a reproduction in a public
issue. You may open a
[redacted issue](https://github.com/locooooooooo/PKR/issues/new) only to request
that the maintainers provide or enable a private GitHub reporting path. Wait for
that private path before sharing sensitive details.

There is currently no published response-time or support SLA.

The executable baseline is documented in the
[threat model](docs/security/threat-model.md),
[privacy and diagnostics policy](docs/security/privacy-and-diagnostics.md), and
[operational limits](docs/operations/limits.md). These records do not replace
independent penetration testing or external review.

Release-facing tests and reports must follow the
[evidence classification](docs/audits/evidence-classification.md). A process
fixture, successful callback, or local process execution is not a real-Agent
audit, Repository Verification, Runtime acceptance, or production security
evidence.
