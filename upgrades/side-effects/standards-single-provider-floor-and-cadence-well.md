# Side-Effects Review — single-provider floor and the deferral-to-the-cadence gravity well

**Version / slug:** `standards-single-provider-floor-and-cadence-well`
**Date:** `2026-10-30`
**Author:** `echo`
**Second-pass reviewer:** `independent general-purpose reviewer subagent (see below)`

## Summary of the change

Documentation only. `docs/STANDARDS-REGISTRY.md` gains two edits: "One provider is enough" under Framework-Agnostic (mirroring Instar 2.0 Rule 118), and a fifth named gravity well, deferral-to-the-cadence. The family review report, its audit JSON and the area-audit ledger are stamped to the final text. No runtime code changes.

## Side effects

- Over-block, under-block: none. Nothing reads this text as a gate. The ratchet checks only that the audit chain matches.
- Runtime and migration: none; the registry is not installed on agents by this change.
- Rollback: revert the squash commit, which restores the prior registry text and ledger together.
- New debt, stated openly: the single-provider obligation is unenforced and carries the countdown `2026-12-21`. Today's second-provider features fall short of it.

## Second-pass review (required: protected path)

**Reviewer:** independent general-purpose reviewer subagent (read the diff and merged Rule 118, not a conclusion)
**Independent read of the artifact: concern → resolved, then concur**

First concern: the wording let a feature's pre-feature behaviour satisfy the floor, which is looser than merged Rule 118 ("delivers the feature rather than refusing, holding or switching it off"). Resolved: the registry now uses Rule 118's standard. Second concern: "proposed in instar-2 PR 182" was stale. Resolved. On re-review the reviewer concurred. It recomputed the report and audit hashes by hand, and `standards-coverage.mjs` and the ratchet test (38/38) passed. It left one non-blocking nit: "That was safe" in Earned-from sits awkwardly beside "does not pass"; that sentence is a historical account and is left as written.
