# Side-Effects Review — system-topic adoption: short retry until the first successful holder read

**Version / slug:** `system-topic-adoption-first-pass-retry`
**Date:** `2026-10-20`
**Author:** `echo`
**Second-pass reviewer:** `not required (timing refinement of a loop whose convergence model is already registered; no new decision surface)`

## Summary of the change

`src/messaging/SystemTopicAdoption.ts` — `startSystemTopicAdoptionLoop` gains a bounded short retry: while no pass has yet READ the lease holder's record (outcomes `no-holder`, `fetch-failed`, `holder-has-none`), the next pass runs after `SYSTEM_TOPIC_ADOPTION_RETRY_MS` (2 min) instead of the 30-min cadence, at most `SYSTEM_TOPIC_ADOPTION_MAX_SHORT_RETRIES` (10) times. A pass that read the holder (`adopted`, `unchanged`) or that found this machine holding the lease (`holder`) ends the short retries. Stop clears the pending retry. Tests in `tests/unit/system-topic-single-creator.test.ts` (fake timers).

## Decision-point inventory

- Adoption cadence — **modify** — a short retry before the first successful read. No change to WHAT is adopted or WHEN it is written (the per-kind brake + idempotence are untouched).

---

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface — under-block not applicable. Bound: a holder that stays unreachable costs at most 10 extra read attempts (one small authenticated GET each) in the first ~20 min after boot, then the cadence.

## 3. Level-of-abstraction fit

Same loop, same deps; the retry decision keys on the pass's own typed outcome, not on timing heuristics.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point: "retry a read that found nothing to read" is an invariant.

## 5. Interactions

- Self-action convergence: the registered `system-topic-adoption` model's bounds hold — emits are gated by `withAdoptionBrake` (≤3 per kind per boot) and idempotence regardless of how often a pass runs; the short retry adds at most 10 extra READS, no extra writes. The retry carries the same `@self-action-controller: system-topic-adoption` marker.
- Single-flight `running` guard unchanged; a retry that fires while a cadence pass is running is a no-op.

- Test hygiene: `tests/e2e/threadline/pairing-enable-without-restart.test.ts` (#2248) gains `useHermeticHome()` so `bootstrapThreadline` writes into a temp HOME; this satisfies the hermetic-home ratchet (aa8ac670d) that was failing unit shard 2/4 on main. Test-only; no runtime surface.

## 6. External surfaces

Up to 10 extra `GET /telegram/system-topics` calls to the holder in the first ~20 min after a standby boots. No user-visible messages. No operator-facing actions.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Unchanged: **replicated (pull from the holder)** for the system-topic ids; the retry only shortens time-to-convergence on a standby.

## 8. Rollback cost

Pure code revert; no state involved.

## Conclusion

Ships. Closes the 30-min empty-record window seen on Mama PC on 2026-10-20 without changing any write.

## Second-pass review (if required)

Not required.

## Evidence pointers

See `upgrades/next/system-topic-adoption-first-pass-retry.md` → Evidence.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`**: `unbounded-self-action` — this modifies a self-triggered controller (the adoption cadence gains a bounded short retry).
- **`closure`**: `guard`
- **`guardEvidence`**: enforcement `ratchet`, citation `tests/unit/self-action-convergence.test.ts` (registry entry `system-topic-adoption`). How it would catch this defect: the retry is count-bounded (10) and only ever re-runs a READ; writes stay behind `withAdoptionBrake` (≤3 per kind per boot) and idempotence, so the ratchet's boundK 9 / perTarget 3 still holds under a flapping or unreachable holder.
