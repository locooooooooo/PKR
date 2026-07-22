# Contributing to PKR

PKR is an alpha project with a repository-first trust boundary. Keep changes
small, attributable, and independently verifiable. Node.js 24, Python 3.11,
Git, and the Python packages in `conformance/requirements.txt` are required.

Start from a clean dependency install and run the complete local gate:

```text
npm ci
py -3.11 -m pip install --requirement conformance/requirements.txt
npm run verify
npm run check:clean
```

Use `python -m pip ...` on Ubuntu. The Windows launcher form avoids the Windows
Store `python` alias.

The GitHub Actions CI workflow runs the candidate gates, benchmark, soak, and a
final clean-worktree check on both Windows and Ubuntu. A local pass is required
before a pull request, but it does not substitute for the remote matrix result.

## Repository contribution path

Use a disposable Git repository for the smallest product-level validation. Run
`pkr init` there first, then use the following path after building this checkout:

```text
npm run build
node dist/cli.js setup --project PATH_TO_TARGET_REPOSITORY --quickstart
node dist/cli.js run --project PATH_TO_TARGET_REPOSITORY --request "Make one bounded contribution"
node dist/cli.js agent register --project PATH_TO_TARGET_REPOSITORY --name contributor-agent --host local
node dist/cli.js lps claim --project PATH_TO_TARGET_REPOSITORY --task TASK_ID --agent AGENT_ID --session-locator "local://contribution"
# Edit the target repository within the claimed scope.
node dist/cli.js lps submit --project PATH_TO_TARGET_REPOSITORY --assignment ASSIGNMENT_ID --agent AGENT_ID --outcome partial
node dist/cli.js verify --project PATH_TO_TARGET_REPOSITORY --task TASK_ID --assignment ASSIGNMENT_ID
```

Read `TASK_ID`, `AGENT_ID`, and `ASSIGNMENT_ID` from the preceding JSON
results. `setup --quickstart` installs demonstration verification files; replace
them with checks appropriate to the target before treating the result as release
evidence.

## Change-specific gates

For Runtime, CLI, adapter, or repository-script changes, run `npm test` while
iterating and `npm run verify` before submission. Add or update focused tests for
behavioral changes.

For specifications, schemas, or conformance fixtures, run
`npm run verify:schemas` and then `npm run verify`. Changes to generated v0.4
artifacts must start from `npm run generate:v0.4`, and the generated schema and
fixture changes must be reviewed with their source change.

For package metadata or public-file changes, also run
`npm run check:candidate`, `npm pack --dry-run --json`, and
`npm run check:fresh-install`. Verify that every packed path is intentional and
covered by the package `files` allowlist. Apache-2.0 is the candidate source
license. Do not remove `private: true`, change the release version, publish a
package, or create release metadata without the corresponding owner decision.

## Working-tree and authority boundaries

Do not reset, hide, overwrite, or include unrelated changes from a dirty working
tree. Record the baseline status, keep the contribution within its declared
paths, and review both staged and unstaged diffs before submission. Never commit
`.pkr/` databases, credentials, private prompts, provider logs, or machine-local
paths.

The SQLite database at `.pkr/runtime.sqlite` is authoritative PKR state. JSON
projections, LPS boards, task cards, Memory views, Agent output, Provider
callbacks, and `lps submit` reports are derived or non-authoritative evidence.
Only an independent successful `pkr verify` may create acceptance, and it must
evaluate the live Git revision, dirty state, path scope, and configured commands.

The ignored `release/` directory is an independent repository. Do not modify or
commit it as part of a contribution to this checkout.

## Evidence labels

Use the [release evidence classification](docs/audits/evidence-classification.md)
for audits and release records. Checked-in `provider.mjs` behavior is
`automated_fake_provider`; do not describe it as a real Provider or real-Agent
audit. Keep Repository Verification and Runtime acceptance identifiers and
event ranges separate from any Agent or Provider work report.
