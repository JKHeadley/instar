# Side-Effects Review — pin the clock in the console Plans and Promises DOM tests

**Version / slug:** `console-tests-clock-pin`
**Date:** `2026-11-01`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, 2 test files, about 12 lines. `tests/unit/console-plans.test.ts` and
`tests/unit/console-promises.test.ts` load the shipped console page in jsdom with
fixtures dated relative to a fixed `NOW` (2026-10-25T23:30Z), but the page computes
ages from `Date.now()`. Seven days after `NOW` the Plans fixtures stopped counting
as "moving" and the test failed deterministically, which put main into the
Local Verify main-red hold. Both "page in a DOM" blocks now call
`vi.useFakeTimers({ toFake: ['Date'], now: NOW })` before each test and
`vi.useRealTimers()` after. Effort: one review round, one commit.

## Decision-point inventory

No decision-point surface — test-only change; no runtime code is touched.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. The other 15 console page
test files were run with the process clock shifted +400 days and pass, so no
sibling carries the same time bomb today.

---

## 3. Level-of-abstraction fit

The defect is in the tests (fixed fixture dates against a live clock), so the fix
belongs in the tests. Changing the page to accept an injected clock would move
shipped code for a test concern.

---

## 4. Signal vs authority compliance

Not applicable — no detector or authority is added or changed.

---

## 5. Interactions

Only `Date` is faked, so the page's `setTimeout` / `requestAnimationFrame` waits
in these tests still run on real timers. `useRealTimers()` in `afterEach` restores
`Date` before the next test or file in the same worker.

---

## 6. External surfaces

None. Nothing shipped to agents or users changes. Main's Local Verify health
returns to green once this lands, which releases PRs held for main-red.

---

## 7. Multi-machine posture

Not applicable — test-only.

---

## 8. Rollback cost

A plain revert of the two test files; no state or data involved.
