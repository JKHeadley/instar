# Side-Effects Review — Cutover-readiness live-fetch max-hold (lock-boundary backstop, #948)

**Version / slug:** `cutover-parity-lock-maxhold`
**Date:** `2026-06-07`
**Author:** `echo`
**Second-pass reviewer:** `self-review (single-file behavioral hardening; both branches — stalled and healthy — covered by Tier-1 tests over the real CutoverReadiness)`

## Summary of the change

Fixes #948: `CutoverReadiness`'s single-flight lock (`liveFetchInFlight`) could be held
indefinitely when an injected live fetch (parity pass or import dry-run) never settled —
observed ~85 minutes in production (`logs/server.log`), permanently refusing every
subsequent parity pass + dry-run with "live source fetch already in flight" and starving
the parity feeder (so the cutover window went stale and never refreshed).

Root: the lock is released in a `finally`, which is correct — but a `finally` cannot run
while the awaited promise never settles. `HttpParitySource.prepare()` has per-page +
between-page bounds, so the stall is either an `AbortSignal.timeout` that doesn't fire on a
particular socket stall, or the un-timed compare step. Rather than chase the sub-cause, the
fix adds a wall-clock **max-hold guard at the lock boundary** (`withMaxHold`, default 12m):
the awaited fetch is raced against a timer, so the lock ALWAYS releases within a bounded
time regardless of why the fetch stalled. Structure > willpower — the lock-holder enforces
its own max-hold, independent of the injected fetch's internal timeouts.

Files: `src/feedback-factory/cutoverReadiness.ts` (+ `tests/unit/cutover-readiness.test.ts`).

## Decision-point inventory

- `withMaxHold` — add — a private timeout-race helper. NO decision authority: it only
  bounds how long the single-flight lock can be held; it never decides parity/integrity.
- `maxLiveFetchMs` config (default 12m) — add — a backstop dial, set comfortably above
  `HttpParitySource`'s 600s total budget so it only fires when that inner budget genuinely
  failed (never a false-abort of a slow-but-working pass).

## 1. Over-block

The only thing the max-hold can "block" is a live fetch that exceeds 12 minutes. A healthy
parity pass (~15s/page, 600s inner budget) is far under that, so a working pass is never
aborted. Default chosen above the inner budget specifically to avoid over-block.

## 2. Under-block

If a stall somehow resolved at exactly the budget edge, the worst case is one wasted sweep
(recorded nothing) and a retry next tick — strictly better than the pre-fix infinite hold.

## 3. Level-of-abstraction fit

Correct. The guard sits at the single-flight-lock boundary it protects, not inside the
fetch (which already has its own, evidently-insufficient, internal timeouts). It is a
backstop, not a replacement — the inner budgets still do the primary bounding.

## 4. Signal vs authority compliance

- [x] No block/allow authority. The change only ensures a lock releases; it never gates a
  parity/integrity decision. `runParityPass` still records nothing on failure (a max-hold
  timeout is a failed check = absence of evidence, exactly as a fetch error already was).

## 5. Interactions

- **Orphaned work:** when the max-hold fires, the abandoned fetch promise keeps running but
  is harmless — its later settlement is ignored (control already left the `await`; the
  `recordResult` line after it is never reached for the timed-out call), so it cannot
  double-record or re-acquire the lock. It holds at most one connection until it aborts or
  the process restarts — a bounded, acceptable cost versus an unreleasable lock.
- **Double-fire:** none — `Promise.race` settles once; `clearTimeout` in `finally` disarms
  the timer on the happy path.
- **Clock:** the guard uses real `setTimeout` (NOT the injected `now()`), because the bug is
  a promise that never settles in REAL time; an injected test clock must not disarm it.

## 6. External surfaces

- **Install base:** `maxLiveFetchMs` is a new OPTIONAL dep with a safe default → existing
  agents get the backstop automatically on update, no config change required (Migration
  Parity: the default IS the fix; nothing to migrate).
- **Persistent state:** none new.
- **Other agents / attention queue:** unchanged.

## 7. Rollback cost

Pure additive hardening. Back-out = revert the commit. No persistent-state cleanup; healthy
passes behave identically with or without the guard.

## Conclusion

A wall-clock backstop on a single-flight lock, proven by a Tier-1 regression that a
never-settling fetch now releases the lock (a later pass proceeds) instead of hanging it
for ~85 minutes. No new authority; safe default; auto-applies to existing agents.

## Evidence pointers

- Tier 1: `tests/unit/cutover-readiness.test.ts` — 2 new (#948 regression for both
  `runParityPass` and `runImportDryRunPass`: a never-settling fetch hits the max-hold,
  returns `ok:false`, and the lock releases so the next pass records normally) + the 20
  existing cutover tests still green through the new code path (22 total).
- tsc `--noEmit` clean.
