# PKR Quickstart Fixture

For the default Agent-native path, run the controlled setup command in a target
Git repository after `pkr init`:

```powershell
pkr setup --quickstart
```

This copies only `verification.json` and `verify.mjs` into the target `.pkr/`
directory. Existing files are preserved unless `--force` is explicit.

The already loaded Agent may then use `lps claim`, write
`src/pkr-quickstart-result.txt`, and use `lps submit`. Only independent
Verification can produce acceptance.

The Verification plan and script in this directory are demonstration fixtures,
not production acceptance standards. Replace them with project-specific checks
before using Verification for a real release.

`provider.json` and `provider.mjs` are an optional fake Provider fixture for
`lps adapter-run` and `doctor --adapter`. They test the local process protocol;
they are not a real-Agent audit or evidence of a second heterogeneous Provider.
The fixture is still a trusted local host command, and PKR does not provide an
OS-level filesystem or network sandbox.
