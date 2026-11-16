# Side-Effects Review — browser re-enrollment test no longer depends on two clock reads differing

**Version / slug:** `browser-reenrollment-test-clock`
**Date:** `2026-11-15`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, test-only. 1 test file (4 added lines) plus this artifact, an ELI16 and an internal-only release note. Effort: no spec, one attempt. `tests/unit/telegram-origin/browser-reenrollment.test.ts` compared two proof digests that include `checkedAt` (`Date.now()`, `src/messaging/telegram-origin/OriginBrowserEnrollment.ts:92-93`). Two enrollments in one millisecond give equal digests, which failed PR 3212's Local Verify run on the M5 at 2026-11-16T03:15:56Z. The test now waits for the clock to pass the first enrollment's `checkedAt`.

## Decision-point inventory

No decision-point surface. No product code is changed.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. The assertion that the digest changes is kept, so a regression that stopped including the time or the prior state in the digest is still caught.

---

## 3. Level-of-abstraction fit

Right layer: the defect is in the test's assumption about the clock, not in the product. Equal digests for identical state in the same millisecond are not a product fault; no reader compares consecutive digests for inequality (`TelegramOriginBoot.ts:272` compares the live proof with the current one for equality only).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

Test-only.

## 4b. Judgment-point check (Judgment Within Floors standard)

No heuristic added at any decision point.

---

## 5. Interactions

None. The wait is a loop on `Date.now() <= first` with 1 ms sleeps and real timers; this file does not use fake timers, so the loop cannot stall. It adds at most a few milliseconds to one test.

---

## 6. External surfaces

None. No operator surface touched (6b not applicable).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

machine-local BY DESIGN: a unit test; it runs wherever the suite runs and holds no state. The failure it removes was machine-dependent (it showed on the faster machine), which is the reason for the change. No notices, durable state, URLs or status surfaces.

---

## 8. Rollback cost

Revert the test change. No persistent state, nothing user-visible.

---

## Conclusion

Removes one timing-dependent wrongful failure from the verify line with no change to product behaviour. Clear to ship.

---

## Second-pass review (if required)

Not required: test-only, no decision point, no protected product path.

---

## Evidence pointers

- Three consecutive runs of the file: 11 passed each.
- M5 run-detail, PR 3212, 2026-11-16T03:15:56Z.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
