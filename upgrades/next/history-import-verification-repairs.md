# History Import Verification Repairs

<!-- bump: patch -->

## What Changed

Failed cleanup of temporary private export files now produces an internal degradation report even when the route logger is absent. The report uses an error code and fixed descriptions, never raw private paths. Project Git ignore generation removes duplicate candidate entries before writing them, preserving existing exclusions and their ordering.

## What to Tell Your User

Temporary history-import cleanup failures are recorded for investigation. Private history remains excluded from Git, with no repeated generated entry.

## Summary of New Capabilities

None. These repair existing cleanup diagnostics and ignore-file generation.

## Evidence

The new cleanup regression failed before the reporting repair. Existing Git idempotency checks failed before candidate deduplication. After repair, 33 unit and 10 HTTP integration checks passed; one independent review found no concrete issue. Four production lifecycle tests also passed. The SQLite wiring allowlist now accounts for the three existing acquisition/writer handles, all already registered or transaction-scoped. Full verification remains required before publication.
