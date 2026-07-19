# Contributing to PKR

PKR v0.7 is the public Runtime boundary. Keep changes small, attributable,
and testable. Kernel expansion for v0.8/v0.9 is paused during the soak pilot;
new work should first improve release reliability, CLI ergonomics, adapters,
or evidence quality.

Before opening a pull request:

```powershell
npm ci
npm run verify
npm run check:package
```

Do not commit `.pkr/` runtime databases, provider logs containing private
prompts, credentials, or machine-local paths. Public examples must use
temporary repositories and independent verification commands.
