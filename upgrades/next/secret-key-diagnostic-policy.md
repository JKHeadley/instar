# Secret-key diagnostics now report the configured policy

## What Changed

`instar doctor` now opens the encrypted secret store with the same configured key-backend policy used by runtime writers. A machine explicitly configured for a protected file-backed key is therefore reported as file-backed instead of being mislabeled from a different default resolution path.

The secret-sync production-wiring regression test also now proves that both of its source-region boundary markers exist before counting constructor options. A renamed boundary can no longer silently widen the test to the rest of the server file.

## Evidence

- Focused policy-wiring and boundary-guard tests pass.
- A dedicated reintroduction guard pins machine-doctor policy inheritance.

## What to Tell Your User

Machine diagnostics now describe the secret-key storage policy the machine is actually configured to use.

## Summary of New Capabilities

- More trustworthy secret-store diagnostics on headless and explicitly file-keyed machines.
