# Development and Release Repositories

PKR uses two independent Git repositories with different trust boundaries.

## Development repository

- Visibility: private
- Purpose: active RFC work, alternative versions, temporary notes, validation
  tools, release preparation, and local iteration history.

The development repository location and remote are private operational data;
they are not part of the public product contract or public-tree inventory.

`iterations/` is explicitly non-authoritative. Material there may be incomplete,
contradictory, or abandoned. Normative candidates live in `specs/` and become
publishable only after their schemas and conformance checks pass.

## Public release repository

- Remote: `https://github.com/locooooooooo/PKR.git`
- Visibility: public
- Purpose: reviewed Runtime source, tests, product documentation, examples,
  specifications, schemas, conformance material, and release metadata.

The public remote `main` branch is the public product boundary. Promotion work
must use a fresh independent clone or worktree after checking the remote SHA.
The ignored local `release/` directory is historical staging state and must not
be treated as current public truth or as a destination for new promotion work.

After cloning the public repository and confirming its full `main` SHA, project
the reviewed allowlist without pushing:

```text
npm run prepare:public-candidate -- <fresh-public-clone> <full-public-main-sha>
```

The command refuses a dirty target, a mismatched SHA, a non-public `origin`, or
the development checkout itself. It reports the copied, excluded, removed, and
changed-file counts and records `pushAttempted: false`.

## Promotion allowlist

Only reviewed public product paths are promoted:

- release metadata such as `README.md`, `VERSION`, `CHANGELOG.md`, `LICENSE`,
  `NOTICE`, `SECURITY.md`, and `CONTRIBUTING.md`;
- Runtime source, public tests, package metadata, and release-check scripts;
- public product and architecture documentation plus reproducible examples;
- normative or explicitly labeled Draft RFCs, schemas, validators, and
  conformance fixtures;
- sanitized audit records and CI workflows that support public claims.

Development notes under `iterations/`, local Agent state, Git metadata,
credentials, editor files, unreviewed experiments, and private remote details
are excluded.

## Promotion gates

A release commit requires:

1. every promoted JSON file parses;
2. every promoted Markdown link and code fence validates;
3. `npm run check:package` passes;
4. `node scripts/check-public-tree.mjs` passes;
5. all Core, Bootstrap, Runtime Protocol, coordination, and Runtime suites pass;
6. no cache, local Runtime output, private prompt, or machine path is present;
7. a sensitive-data scan finds no credentials or private repository content;
8. the release channel accurately says `draft`, `candidate`, or `stable`;
9. package metadata, NOTICE, and the selected license agree;
10. GitHub publication and npm publication are recorded as separate gates.

Candidate source, package metadata, `LICENSE`, `NOTICE`, and third-party notices
use Apache-2.0 consistently. The package remains `private: true`, versioned
`0.7.0`, and unpublished to npm. License alignment does not itself accept G7 or
authorize publication; those remain separate owner and release decisions.
