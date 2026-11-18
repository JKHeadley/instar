<!-- bump: patch -->
## What Changed

The disk steward's automatic cleanup no longer switches itself off just because npm or Xcode was busy. When a cleanup run's only planned work was skipped because its tool was in use, that run now leaves the cleanup breaker unchanged. Before, it counted as a failed run. On a busy development machine three such skips tripped the breaker, and automatic cleanup stayed off for the rest of the low-disk episode (fb-58754ac0-5e8). Cleanups that run and still free almost nothing count as before.

## What to Tell Your User

Nothing to do. When a machine's disk runs low, the automatic cache cleanup now keeps trying instead of giving up because a tool was busy.

## Summary of New Capabilities

- Busy-tool skips no longer disable automatic disk cleanup.

## Evidence

New unit tests in `tests/unit/diskSteward-breaker-busy.test.ts` cover the Studio's real case: three runs with npm busy plus a partly busy Xcode cleanup now leave the breaker at 0, while three genuinely ineffective runs still trip it. The existing steward suite passes, 17 tests in total.
