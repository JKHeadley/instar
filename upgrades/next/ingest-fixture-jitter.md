<!-- bump: patch -->

## What Changed

`tests/fixtures/feedback-performance-concurrent-ingest.mjs` retried a contended lock on a **flat 5ms
cadence**, 200 times — a ~1 second budget per append. Several such workers run concurrently by design,
so a flat cadence is a thundering herd: every contender wakes on the same tick and they keep colliding
on the same slots. On a loaded runner that budget expired with nobody making progress, and main went
red on 2026-07-28 with `feedback source generation is busy; retry later`.

Now exponential backoff with jitter, capped at 40ms — roughly 6× the patience, de-synchronised, and
still bounded so a genuinely stuck lock fails promptly rather than stalling a 100-iteration loop.

**The production lock is unchanged and needs no change.** It was working correctly: `openSync(path,
'wx')` failing `EEXIST` means the lock is held, and it already checks whether the owning pid is alive
before declaring it live.

## What to Tell Your User

Nothing — a test fixture.

## Summary of New Capabilities

None.

## Evidence

- The fixture is 15 lines and was read in full before the fix. Two earlier diagnoses of this same
  failure were written from the stack trace and were wrong — one dangerously so, proposing to treat the
  lock's `EEXIST` as success, which would have removed mutual exclusion to make a test green.
- Budget measured rather than asserted: flat `200 × 5ms` ≈ 1.0s per append; jittered ≈ 5.9s mean,
  bounded by the 40ms cap.
- This does **not** prove the flake is closed — no retry budget can be proven sufficient under
  arbitrary load. It removes the thundering-herd synchronisation, which is the part that made the old
  budget fail *systematically* rather than occasionally.
