# Three-command Codex demo

This proof creates a temporary Git repository and leaves it on disk for
inspection. It does not modify the PKR checkout.

Prerequisites:

- Node.js 24 or newer;
- an installed and authenticated `codex` CLI;
- Git.

From the PKR repository:

```powershell
npm install
npm run build
node scripts/run-three-command-demo.mjs
```

The script executes the same public surface a user sees:

```powershell
pkr init
pkr run "Implement increment in src/counter.js so node --test passes" `
  --verify "node --test" --model gpt-5.4-mini --reasoning low
pkr status
```

Acceptance requires all of the following:

1. Codex changes `src/counter.js` without changing the test.
2. PKR records the Assignment, callback, repository digest, and verification
   log digest.
3. A separate `node --test` process exits with zero.
4. A fresh `pkr status` process reports `summary.state = completed` and the
   Task phase `done`.

The demo uses `gpt-5.4-mini` with low reasoning to keep this one-line proof
within the target time. Normal project runs may omit both options and use the
Codex CLI defaults.

Run evidence is under `<temporary-project>/.pkr/runs/<assignment>/`.
