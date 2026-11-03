<!-- bump: patch -->

## What Changed

`lastAppliedVersion` in `state/auto-updater.json` no longer goes stale when an update lands by a route other than the success branch of `applyPendingUpdate()`. On a no-update tick, `AutoUpdater.tick()` now moves the record forward to the running version when the running version is newer. It never moves backwards, and a `null` record (never applied) stays `null`. `applyPendingUpdate()` now records `result.newVersion` when `applyUpdate()` installed something newer than the pending target, and restarts toward that version. In-place installs that report the old version still record the target, so the loop breaker keeps matching. Closes #2282.

The docs also gain short sections on `MobilePeople` and `MobileMspGrants`, which restores the class floor in the Docs Coverage check. This is the same text as PR #2666.

## What to Tell Your User

Your agent's update status now shows the version it is really on. Before, an update that finished in an unusual way, such as the agent being stopped partway through, could leave that status stuck on an older version even though the newer one was running. Nothing about how or when updates install has changed.

## Summary of New Capabilities

- The update status repairs itself: a stale "last applied" version catches up to the running version on the next update check.
- When a newer release lands while an update is waiting, the status records the version that was really installed.

## Evidence

`tests/unit/AutoUpdater-lastAppliedVersion.test.ts` adds 5 tests. The two that reproduce the bug fail on main with `expected '1.3.1364' to be '1.3.1387'` and `expected '1.3.1384' to be '1.3.1387'`, and pass with this change. The others cover both sides of each decision: a newer record is not moved backwards, a `null` record is left alone, and an in-place install still records the target. `node scripts/docs-coverage.mjs --check` moves from class 54% (fail) to class 55% (pass). This does not identify which restart path on the affected Linux agent skipped the write; the record now repairs itself whichever path it was.
