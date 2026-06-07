# Side effects — SleepWake drift-burst suppression

## Change

`SleepWakeDetector` gains a load-independent consecutive-drift guard. It counts
back-to-back drift ticks (`consecutiveDrifts`); any on-time tick resets the count. The
Nth+ consecutive SHORT drift (N = `driftBurstSuppressFloor`, default 2) is suppressed as
a CPU-starvation burst regardless of the (lagging, fluctuating) 1-min load ratio — closing
the gap the `maxLoadRatio` guard alone missed when load momentarily dipped below threshold.

## Behavioral surface

- **New config field** `SleepWakeDetectorConfig.driftBurstSuppressFloor` (number, default 2;
  0 disables). Absent → default 2, so the burst guard is ON by default.
- **What changes at runtime**: on a load-churning box, the 2nd-and-onward back-to-back short
  drift no longer emits a `wake` event → no tunnel/recovery restart for it. Suppressions are
  counted under the existing `cpu-starvation` reason in `getStats()` and excluded from
  cumulative-sleep accounting (same path as the load-ratio suppression).
- **What does NOT change**: the first drift in any burst still falls through to the existing
  load-ratio + cooldown checks; a genuine LONG sleep (≥ `longSleepFloorSeconds`, default 300s)
  is exempt and always emits; an isolated real short wake still emits.

## Migration / compatibility

- No migration needed. The field is optional with an in-code default; existing callers that
  never set it get the (safe, more-suppressing) default-2 behavior. No config-schema change is
  shipped to agents — the default lives in the constructor.
- No API route, no persisted state, no on-disk format change.
- Rollback: set `driftBurstSuppressFloor: 0` to restore the exact pre-change behavior (load-ratio
  + cooldown guards only).

## Risk

Low. The guard only ever suppresses MORE false wakes, and only the 2nd+ back-to-back short
drift. Worst case is a delayed reconnect after a genuine short sleep that lands mid-starvation-
burst (rare; self-heals on the next on-time tick / activity). Long-sleep recovery is untouched.

## Tests

`tests/unit/sleep-wake-starvation-guard.test.ts` — 4 new cases (2nd consecutive short drift
suppressed under NORMAL load; floor-0 contrast proves the guard fired; on-time tick resets the
counter; long sleep exempt). 13/13 file-green; `tsc --noEmit` clean.
