# Side-Effects Review — audit-convergence test reads the file list with an explicit buffer

**Version / slug:** `test-lsfiles-buffer`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`tests/unit/audit-convergence-reports.test.ts` failed on main with `spawnSync git ENOBUFS`: the repository's tracked-file list reached 1,049,111 bytes, past Node's 1 MiB default `maxBuffer`. Both of the test's `git ls-files` reads now pass an explicit 64 MiB buffer. Test-only; no product code changes.

## Decision-point inventory

None.

---

## 1. Over-block

None: the test's assertions are unchanged.

## 2. Under-block

None added. The test fails again only if the file list passes 64 MiB.

## 3. Level-of-abstraction fit

The buffer belongs at the call. Other full listings already set one: `scripts/release-skip-annotate.mjs` (64 MiB) and SafeGitExecutor (10 MiB default). `src/core/PostUpdateMigrator.ts` lists an agent's project folder, not this repository, and is left alone.

## 4. Signal vs authority compliance

Not applicable: no runtime decision.

## 5. Interactions

Unblocks the local-verify queue, which held PRs 2719, 2733 and 2734 while main was red on this file.

## 6. External surfaces

None.

## 7. Multi-machine posture

Test code; not applicable.

## 8. Rollback cost

Revert one test file.
