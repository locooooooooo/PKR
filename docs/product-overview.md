# Why PKR

An Agent tool can edit a checkout and return a successful-looking message. That
still leaves four questions unanswered: what state is authoritative, did the
declared repository check run, can a failure be resumed, and what evidence can
someone inspect later?

PKR is the project framework and Runtime around that gap, not a wrapper around
one model or CLI. It gives humans, Agents, tools, and workflows one
authoritative project state and a governed operating contract. The current
reference implementation stores that state and audit trail in `.pkr/runtime.sqlite`,
asks a separate
Repository Verifier to run the declared check, and records enough Git/process
evidence to recompute acceptance after the Provider has finished. A fresh
`pkr status` process reads the same state, so a restart does not turn an
in-progress or blocked run into an undocumented guess.

## The three boundaries

- **Provider work report:** the Provider describes the work it attempted and the
  repository changes it declares. This is useful evidence, but it is not
  acceptance and a `verified` callback cannot close a Task.
- **Repository Verification:** the Verifier runs the declared host command and
  captures its exit result plus Git HEAD, status, diff, staged diff, and changed
  paths. Failed verification remains durable evidence.
- **Runtime acceptance:** PKR re-collects current evidence, checks the declared
  scope and command, and creates acceptance only after a passing Verification.
  Otherwise the Task remains blocked and visible to `pkr status`.

This separation is the product: Agent execution can be useful without being
the authority that decides whether the repository is done.

## What this alpha is

- A source-installed, local reference Runtime for an existing Git repository.
- A Provider-neutral Runtime contract with one current local adapter.
- A small CLI path: `pkr init`, `pkr run`, and `pkr status`.
- A public alpha with deterministic fake-Provider CI tests and an optional
  local real-Provider audit.

## What this alpha is not

- Not a hosted or multi-tenant cloud service.
- Not an OS sandbox: Provider and verification commands are trusted host
  processes with the current user's filesystem, network, and credentials.
- Not a general Agent marketplace, model router, or automatic model-selection
  service.
- Not a published npm package yet. Use the source install in the README.
- Not a production-stability or adoption claim. The API is pre-stable and the
  soak material is a time-bounded pilot record.

## Evidence you can inspect

- The [public verification workflow](../.github/workflows/verify.yml) runs the
  supported checks on Windows and Linux.
- The [v0.7.0-alpha.1 release notes](releases/v0.7.0-alpha.1.md) state the tag's
  prerequisites and non-goals.
- The [sanitized real-Provider audit](../soak/audits/2026-07-19-public-alpha1-real-codex.json)
  records one optional local success observation without a machine path,
  credential, full prompt, or source content.
- The [release regression tests](../src/release.test.ts) use a fake Provider
  executable to prove both completed and blocked recovery paths deterministically.

The detailed RFCs under `specs/` explain the design contracts; they should not
be read as additional v0.7 product capabilities.
