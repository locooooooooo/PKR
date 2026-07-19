# v0.7 real-project soak

The v0.7 kernel is frozen while this pilot runs. The public claim is a
time-bounded observation, not a promise that every agent run succeeds.

## Acceptance window

- three real Git projects;
- 14 consecutive calendar days (a 7-day minimum is acceptable only if called
  out explicitly);
- at least one bounded `pkr run` per project per day;
- a fresh `pkr status` read after every run;
- every failure has a linked recovery run or remains explicitly open;
- daily audit entries expose outcome, independent-test result, state digest, and
  the next action without publishing source or credentials.

Use the public helper for one observation:

```powershell
node scripts/soak-run.mjs `
  --name project-a `
  --project C:\path\to\project-a `
  --task "Fix one bounded failing test" `
  --verify "npm test" `
  --audit-dir soak/audits
```

The helper exits non-zero for a blocked run, but still writes the audit entry.
That is intentional: a failure is evidence, not a missing report. Do not use
the same dirty checkout from two workers at once.

## Public audit format

Each entry in `audits/` contains:

- project name and observation timestamp;
- PKR outcome and fresh status summary;
- independent verification command and exit result;
- state digest and callback evidence IDs;
- failure classification, recovery link, and next action.

Paths, credentials, prompts containing secrets, and full source diffs stay
private. Publish a sanitized daily/weekly summary only after checking it with
`node scripts/check-public-tree.mjs`.

The first public release must label this section `pilot-started` until the
full window is complete. A green demo is not a two-week reliability claim.
