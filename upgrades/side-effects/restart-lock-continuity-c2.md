# Side-Effects Review — After an unlock, the screen check runs again at once (restart-lock-continuity C.2)

**Version / slug:** `restart-lock-continuity-c2`
**Date:** `2026-11-18`
**Author:** `echo (echo-machine-stewardship)`
**Second-pass reviewer:** `independent subagent (wedge monitor)`

## Summary of the change

This changes the wedge monitor in `WedgeMonitor.sample()`, on macOS only. It covers the first definite `unlocked` reading after a `locked` one, while the screen-access canary has not passed this boot. An `unknown` reading in between does not break the episode.

**On that reading:**
- the monitor opens a 30-minute diagnostic window (`POST_UNLOCK_WINDOW_MS`);
- it makes the next sample due at once, through one unref'd 1 s timer that calls `tick()`; `tick()` already skips while a sample runs.

**Inside the window,** each sample appends one `post-unlock-canary` row to `logs/machine-maintenance.jsonl`. The row records:
- the trigger (`unlock` or `follow-up`);
- whether the `open` call succeeded, with its exit code and whether it timed out;
- whether the canary process was found stopped;
- the F1 result.

Readings, rungs and notices keep their rules; the one extra sample is an ordinary sample (see Interactions for its effect on spacing). `stop()` clears the timer and a stopped monitor never arms one. An observer period forgets the last lock reading. Without the canary installed nothing triggers.

Spec: `docs/specs/restart-lock-continuity.md` C.2, approved by the Chief of Staff (msg 4f877632).

## Decision-point inventory

"Extra canary sample on unlock" is invariant, per the spec's table. It is one sample, only on the locked-to-unlocked transition, and only while F1 has not passed this boot.

## 1. Over-block

None. It blocks nothing.

## 2. Under-block

- Machines with machine maintenance off (the M5 today) run no wedge monitor, so they get no re-sample. The spec says so ("where the wedge monitor runs").
- An observer agent (not the maintainer) does not sample, by design.

## 3. Level-of-abstraction fit

The change sits inside the sampler that already reads the lock state and runs the canary. Adding no new loop is the point.

## 4. Signal vs authority compliance

Diagnostic rows only. The extra sample feeds the existing window like any other sample.

## 5. Interactions

- The extra sample adds one canary launch per unlock episode. The existing leftover handling (reap before and after) applies to it.
- A sample brought forward could move a two-family candidate a few minutes earlier, the same as any 2-minute sample after an F1 failure already does.
- **F2 span:** the extra sample, about 1 s after the triggering one, shortens the three-sample span behind F2's rising-count reading from about 20 minutes to about 10 minutes. That happens once per unlock episode. It is accepted for two reasons: the 2-minute cadence after an F1 failure already compresses the spacing the same way, and a candidate still needs two families over the window's 20-minute minimum.
- The timer is replaced, never stacked, and is cleared on `stop()`. A sample that is in flight when `stop()` is called arms no new timer.

## 6. External surfaces

New log rows, `post-unlock-canary`. No routes or config.

## 6b. Operator-surface quality

Log rows only, for diagnosis.

## 7. Multi-machine posture

Machine-local by design: `machine-local-justification: hardware-bound-resource`. Each Mac's console lock and GUI canary belong to that Mac's hardware session.

## 8. Rollback cost

Revert. The log rows are append-only.

## Conclusion

Low risk and diagnostic. It closes C.2 of the restart-lock-continuity spec.

## Second-pass review (if required)

Round 1 raised four concerns, all fixed:
1. The extra-sample timer could be armed by an in-flight sample after `stop()`. A `stopped` flag now prevents that, and a test covers it.
2. A lock reading kept through an observer period could pair with a later unlock. The observer branch now resets `lastLockState` and `postUnlockUntil`.
3. The trigger did not require the canary. It now does, and a test covers it.
4. This artifact overstated "unchanged readings". The F2 span effect is now named in Interactions, with the reason it is acceptable.

## Evidence pointers

- `tests/unit/machine-wedge-unlock-resample.test.ts`: 5 pass (adds: no timer after stop; no canary triggers nothing). It covers:
  - the unlock sample, then a follow-up due at once, then nothing after 30 minutes;
  - no trigger when the canary already passed this boot;
  - an `unknown` reading between locked and unlocked still triggering.
- The existing `machine-wedge-mac-canary.test.ts` and `machine-wedge-monitor.test.ts` pass, 52 tests together.
