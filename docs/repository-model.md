# Source and Release Boundary

This public repository is the source and release tree for PKR v0.7. Public
claims must be supported by its `main` branch, a public tag or GitHub Release,
and the associated GitHub Actions results. Unreleased private development work
is not part of the public product boundary.

## Public authority

- `main` contains the current public source, documentation, examples, and audit
  records.
- `v0.7.0-alpha.1` identifies the published GitHub prerelease candidate.
- `.github/workflows/verify.yml` is the cross-platform repository quality gate.
- GitHub publication and npm publication are separate gates. A successful or
  skipped publish workflow does not prove that an npm package exists.

## Promotion allowlist

Public release changes are limited to reviewed product documentation, Runtime
source and tests, public examples, normative or explicitly draft specifications,
schemas, conformance fixtures, release checks, and sanitized audit records.

The public tree excludes credentials, machine-local paths, `.pkr/` databases,
full private prompts, Provider logs, source diffs from private projects,
temporary design notes, and unreviewed experiments.

## Promotion gates

A public change requires:

1. `npm run verify` passes.
2. `npm run check:package` passes.
3. `node scripts/check-public-tree.mjs` passes.
4. `git diff --check` passes.
5. Local Markdown links resolve and public URLs are reviewed.
6. Version, release, install, and npm claims match live GitHub and registry
   evidence.

The current release uses Apache-2.0. npm remains unpublished until a separate
authenticated publication and install/CLI smoke check succeed.
