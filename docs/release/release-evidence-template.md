# PKR release evidence template

## Candidate identity

- Candidate SHA:
- Branch or detached worktree:
- Package version:
- `VERSION`:
- OS and version:
- Node / npm / Python / Git versions:
- Started at / completed at UTC:
- Evidence collector:
- Independent reviewer:

## Evidence classification

Select only labels supported by attached evidence:

- [ ] `automated_fake_provider`
- [ ] `automated_repository_fixture`
- [ ] `real_agent_audit`
- [ ] `repository_verification`
- [ ] `runtime_acceptance`
- [ ] `packaging_check`

Explain any real-Agent evidence and how prompts, paths, credentials, and private
source were redacted. Never relabel fixture output as a real-Agent audit.

## Command results

| Command | Exit | Started UTC | Duration | Log/artifact | Notes |
| --- | ---: | --- | ---: | --- | --- |
| `npm ci` | | | | | |
| `npm run verify` | | | | | |
| `npm run check:candidate` | | | | | |
| `node scripts/check-public-tree.mjs` | | | | | |
| `npm pack --dry-run --json` | | | | | |
| `npm run check:fresh-install` | | | | | |
| `git diff --check` | | | | | |

## Package and public tree

- Public-tree inventory artifact and SHA-256:
- Tarball filename, size, SHA-256:
- Tarball file count:
- Source CLI version output:
- Installed tarball CLI version output:
- Sensitive-data scan result:
- License / NOTICE / third-party review:
- npm registry state: `unpublished` / `separately authorized and verified`:

## Verification and acceptance separation

- Provider/Agent work report IDs:
- Repository Verification ID, actor, live Git SHA, result, event range:
- Runtime acceptance ID, actor, result, event range:
- Evidence that worker and Verifier differ:
- Failure-path record and event range:

## CI and human evidence

- Windows CI URL/result:
- Ubuntu CI URL/result:
- Newcomer trial participant class and redacted notes:
- Real-Agent audit, if any:

## Blockers and decision

- Open blocker IDs:
- Linked Issues/Decisions and owners:
- Hidden blockers found during review:
- Zero-hidden-blocker declaration accepted by/date:
- Candidate decision: `blocked` / `verified` / `accepted`:

This record cannot authorize a version bump, tag, GitHub Release, remote push,
or npm publication unless the separate release transaction is explicitly
approved after G0-G9 acceptance.
