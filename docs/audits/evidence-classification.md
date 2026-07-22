# Release evidence classification

Every audit or release evidence entry must identify its evidence class. A
stronger-sounding label must never be inferred from a lower layer.

| Label | What it proves | What it does not prove |
| --- | --- | --- |
| `automated_fake_provider` | A checked-in fixture exercised an Adapter protocol path | A real Provider, real Agent, production model, or user succeeded |
| `automated_repository_fixture` | Tests created a disposable Git repository and checked real file/diff behavior | Newcomer usability or external host behavior |
| `real_agent_audit` | A named external Agent host completed the recorded path with redacted evidence | Repository acceptance unless independent Verification also passed |
| `repository_verification` | A distinct Verifier recomputed live Git, scope, artifact, and command evidence | Runtime acceptance unless the guarded transition is recorded |
| `runtime_acceptance` | SQLite authority contains the accepted transition and event range | Public release, production reliability, or user adoption |
| `packaging_check` | Public tree or tarball contents passed declared local checks | Public CI, tag, GitHub Release, npm publication, or fresh-user success |

Current automated suites use fake Provider fixtures and disposable repository
fixtures. No real-Agent audit or newcomer trial is claimed by those suites.
Count real-Agent or newcomer evidence only when a separately identified person
or external host executes the documented path and the result is recorded
without credentials, private prompts, private paths, or private source.
