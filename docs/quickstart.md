# Source quickstart

PKR is currently installed from source. It is not published to npm.

## Prerequisites

- Node.js 24.x;
- Python 3.11;
- Git;
- Windows or Ubuntu for the declared v1 support matrix.

## Build and inspect

```text
npm ci
py -3.11 -m pip install --requirement conformance/requirements.txt
npm run verify
node dist/cli.js --help
```

The command above is for Windows. On Ubuntu, use
`python -m pip install --requirement conformance/requirements.txt`. The Windows
launcher form avoids the Windows Store `python` alias.

Use the [README 5-minute path](../README.md#5-minute-source-path) in a disposable
Git repository for the current repository-native flow. The example Verification
plan is a demonstration fixture, not a production acceptance policy.

## Local tarball smoke

```text
npm run check:package
npm run check:fresh-install
```

These commands build and install a local tarball by file path. They do not call
`npm publish` and do not establish registry ownership or availability.

## Reproducible lifecycle audit

Run the release-facing repository audit from the PKR source checkout:

```text
npm run audit:repository
```

It creates disposable Git repositories and records three bounded outcomes:

- a submitted work report remains non-authoritative until independent
  Repository Verification and Runtime acceptance pass;
- a scope and command failure leaves the Task `blocked` after restart and
  creates no acceptance record;
- an expired Assignment can be reassigned after restart without duplicate live
  work or silent Verification.

The report is `automated_repository_fixture` evidence. It does not claim a real
external Agent host, production workload, or independent newcomer trial.
