---
bump: patch
---

## What Changed

SafeFsExecutor's safeRm/safeRmSync default fs.rm's native transient-error retry (maxRetries 3, retryDelay 100ms) for recursive+force deletes when the caller didn't set maxRetries. Explicit values win; non-recursive deletes unchanged.

## What to Tell Your User

Nothing user-visible — internal robustness. Deleting a directory tree that something else is briefly touching (the classic "directory not empty" race) now retries for a moment instead of failing, which removes a whole class of flaky CI failures and transient cleanup errors.

## Summary of New Capabilities

- All recursive force-deletes through the SafeFsExecutor funnel tolerate transient ENOTEMPTY/EBUSY races (3 retries x 100ms) by default.

## Evidence

Live CI failure (2026-06-05, PR #844's first run): handoff-manager.test.ts cleanup failed ENOTEMPTY rmdir on /tmp/handoff-.../.git on a loaded shard — a green change turned red by a cleanup race every tmpdir test inherits. Pinned by 3 new tests in tests/unit/SafeFsExecutor.test.ts (race-window convergence, explicit maxRetries 0 respected, non-recursive unchanged).
