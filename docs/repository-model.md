# Development and Public Release Repositories

PKR uses two independent Git repositories with different trust boundaries.

## Development repository

- Local path: `<private-development-checkout>`
- Remote: `https://github.com/locooooooooo/PKRProject.git`
- Visibility: private
- Purpose: active RFC work, alternative versions, temporary notes, validation
  tools, release preparation, and local iteration history.

`iterations/` is explicitly non-authoritative. Material there may be incomplete,
contradictory, or abandoned. Normative candidates live in `specs/` and become
publishable only after their schemas and conformance checks pass.

## Public runtime repository

- Local publication target: a sanitized orphan branch from the v0.7 release
  worktree
- Remote: `https://github.com/locooooooooo/PKR.git`
- Visibility: public
- Purpose: v0.7 Runtime source, CLI, normative schemas, conformance material,
  examples, audit protocol, and release metadata.

The public branch is an orphan history. It is not a generated directory
committed into `PKRProject` and is not a mirror of private development notes.

## Promotion allowlist

Only these paths are promoted by default:

- public release `README.md`, `VERSION`, `LICENSE`, and package metadata;
- Runtime source, tests, public examples, and release checks;
- `specs/` normative or explicitly labeled Draft RFCs;
- `schemas/` machine-readable normative contracts;
- `conformance/requirements.txt`, shared validation support, validators, and
  versioned fixtures.

Development notes, local Agent state, Git metadata, credentials, editor files,
unreviewed experiments, and the development repository README are excluded.

## Promotion gates

A release commit requires:

1. every promoted JSON file parses;
2. every promoted Markdown link and code fence validates;
3. all Core, Bootstrap, and Runtime Protocol conformance suites pass;
4. no Python cache or local runtime output is present;
5. a sensitive-data scan finds no credentials or machine-local secrets;
6. the release channel accurately says `draft`, `candidate`, or `stable`;
7. a stable release has an explicitly selected license.

The v0.7 release uses Apache-2.0. Public visibility and npm publication are
separate gates: both the GitHub tree and the npm tarball are scanned before
publication.
