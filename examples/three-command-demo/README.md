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
2. The Codex callback remains a non-authoritative work report.
3. The repository Verifier records Git and process evidence for `node --test`.
4. The Runtime re-collects Git evidence, recomputes the verdict, and creates
   acceptance only when the command exits with zero.
5. A fresh `pkr status` process reports `summary.state = completed` and the
   Task phase `done`.

To exercise the negative path, run the same demo with a deliberately failing
Repository Verifier:

```powershell
node scripts/run-three-command-demo.mjs --case blocked
```

This command is expected to finish with a blocked Task and a non-zero exit
from `pkr run`; the wrapper still reopens `pkr status` and exits successfully
only when it observes `summary.state = attentionRequired`, a blocked Task, and
no acceptance Verification. It is a demonstration of recovery evidence, not
a claim that every real Agent run succeeds.

The demo uses `gpt-5.4-mini` with low reasoning to keep this one-line proof
within the target time. Normal project runs may omit both options and use the
Codex CLI defaults.

Run evidence is under `<temporary-project>/.pkr/runs/<assignment>/`.
Codex and the Verifier run as trusted host commands; this demo does not provide
an OS sandbox.
