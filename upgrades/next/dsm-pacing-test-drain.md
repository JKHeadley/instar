<!-- bump: patch -->
## What Changed

Test-only: `tests/unit/DesktopStreamManager.test.ts` "asks a faster video session for pictures more often" now waits until the first stream has stopped scheduling frame timers (no pace timer for 250 ms, capped at 5 s) instead of a fixed 150 ms pause. On loaded CI runners the closed socket's close event arrived late, the first stream kept ticking, and its 67 ms timers were counted in the faster measurement (`expected 67 to be less than or equal to 50`). That failed unit shard 2/4 on PR 3255 three times in a row. No runtime code changes.

## What to Tell Your User

Nothing changes for you. This removes a flaky test that was holding back unrelated fixes.

## Summary of New Capabilities

None. Test-only fix for a flaky remote-desktop pacing test.

## Evidence

Not reproducible in dev: the file passes locally on the Studio (3 of 3 runs before the change, 2 of 2 after). Before: GitHub CI unit shard 2/4 failed three times at DesktopStreamManager.test.ts:66 with "expected 67 to be less than or equal to 50" (runs 43954572952 and 43986607817, PR 3255, after #3223 was on main). After: this PR's CI run.
