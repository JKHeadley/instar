# Side-Effects Review — /health reports external and arrayBuffers memory

**Version / slug:** `health-memory-external`
**Date:** `2026-11-19`
**Author:** `echo`
**Second-pass reviewer:** `not requi## Summary of the## Summary of the change
`GET /health` adds `memory.external` and `memory.arrayBuffers` (MB) from `process.memoryUsage()`, next to the existing `rss`, `heapUsed` and `heapTotal`. It is read-only and adds no new route, state or work: the same `memoryUsage()` call already ran in this handler.

**Why.** The throughput session asked for it (fb-d0ed33d6-e7b follow-up). The Studio server's resident size is 1.5 to 2.2 GB above its V8 heap, and profilers are not allowed on live servers.

**Exposure.** These fields sit in the same object, under the same auth branch, as the memory figures already reported, so the exposure class is unchanged.

 inventory
None: comment-only, no runtime change.

## 1. Over-block
No issue identified.

## 2. Under-block
No issue identified.

## 3. Level-of-abstraction fit
No issue identified.

## 4. Signal vs authority compliance
No issue identified: no decision logic changes.

## 4b. Judgment-point check (Judgment Within Floors standard)
None.

## 5. Interactions
None. The ratchet counts 494 again.

## 6. External surfaces
None.

## 6b. Operator-surface quality (Operator-Surface Quality standard)
None.

## 7. Multi-machine posture (Cross-Machine Coherence)
Not applicable.

## 8. Rollback cost
Trivial (a revert).

## Conclusion
Safe: comments only.

## Second-pass review (if required)
Not required.

## Evidence pointers
`tests/unit/server.test.ts` passes 18/18 with the new assertions, and tsc is clean.

## Class-Closure Declaration (display-only mirror)
n/a: comment-only.
