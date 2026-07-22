# PKR non-author newcomer trial

- Date: 2026-07-22
- Audited candidate: `4211473a571f3ba4010f3c211dbdee27f4e1c677`
- Evidence class: `newcomer_trial`
- Participant class: non-author task session
- Environment: Windows, Node.js 24, Python 3.11, Git
- Outcome: passed

The participant read only the public README and quickstart before executing the
path. The implementation source was not inspected to discover undocumented
workarounds. The candidate checkout and disposable target repository were
separate, and both were removed or left clean after the trial.

## Source and candidate checks

- `npm ci` completed and audited nine packages with zero vulnerabilities.
- The documented Windows `py -3.11 -m pip ...` command completed without a
  fallback.
- `npm run verify` passed all schema and semantic checks, 53 of 53 Node tests,
  and the public-tree plus tarball sensitive-data scan with zero findings.
- `node dist/cli.js --help` exposed the documented `init`, `run`, and `status`
  command surface.

## Repository path

In a new disposable Git repository:

- `init` created active local Runtime state;
- `setup --quickstart` installed two demonstration Verification fixtures;
- `doctor` reported `ready=true`;
- `run` created a governed `backlog` Task with `claim=ready`;
- `status` reopened and reported the persisted state.

The longer README path also completed: Steward intake, Agent registration,
claim, one bounded file change, non-authoritative submit, independent
Repository Verification, Runtime acceptance, status, and board reconstruction.
The final Task assurance was `verified`, the worker was `archived`, and the
board reported zero blockers.

`npm run audit:repository` separately reproduced successful completion,
verification failure followed by durable `blocked` state, and restart recovery
without duplicate live work or silent acceptance. Its report remained labeled
`automated_repository_fixture`, not real Provider or newcomer evidence.

## Boundaries

This trial proves one documented source-install path on one declared Windows
environment. It does not prove npm publication, human adoption, production
stability, an operating-system sandbox, cloud operation, or support for every
Agent or Provider. Node.js emitted its documented experimental SQLite warning;
the warning did not fail a command or alter the final clean state.
