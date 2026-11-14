# Side-Effects Review — one shared archive for the Codex rollout lookup test

**Version / slug:** `codex-rollout-test-shared-archive`
**Date:** `2026-11-12`
**Author:** `Echo`
**Second-pass reviewer:** `not required (test-only, no decision point)`

## Summary of the change

Tier 1. One test file, about 60 changed lines, no product code. One commit attempt expected, no spec review rounds. Four tests in `tests/unit/codexRolloutLookup-bounded.test.ts` each built and deleted a 25,000-file archive; they now share one built lazily and removed in `afterAll`. Measured: 363 s inside a full verify run (slowest unit file of 3,598); 34.5 s alone before, 3.4 s alone after.

## Decision-point inventory

None. No runtime code changes.

## 1. Over-block

No issue identified. Nothing is rejected that was accepted before.

## 2. Under-block

The one risk of a shared fixture is a test passing because of what an earlier test left behind. Checked for each of the four: lookup state is reset in `beforeEach`; each test looks up a different id (77, 5, 123, 66); the two tests that write a rollout remove it in `finally`; the count assertions are `toBe(partitions)` for directories (unchanged by an extra file) and `>=` for names. A leftover file after a crash between write and removal would still satisfy every assertion.

## 3. Level-of-abstraction fit

The sharing lives in the one test file that needs it. The fixture helper is unchanged, so its other two users (an integration and an e2e test) are untouched.

## 4. Signal vs authority compliance

Not applicable: no decision point, no gate, no detector.

## 4b. Judgment-point check

Not applicable.

## 5. Interactions

`afterEach` still removes the per-test folder; the shared folder is removed once in `afterAll`. If the file is interrupted, the shared folder is left in the OS temp directory like any other interrupted test's fixture.

## 6. External surfaces

None.

## 7. Multi-machine posture

Machine-local by design: a test fixture in a temporary folder.

## 8. Rollback cost

Revert the commit.

## Conclusion

Removes about 75,000 file creations and deletions from every unit run with no change to what is asserted. Ship.

## Second-pass review (if required)

Not required: test-only change with no block/allow decision, session lifecycle, gate, sentinel, guard or watchdog surface.

## Evidence pointers

- Per-file and per-test times from the vitest JSON report of the Local Verify run of PR 3097 (Studio, 2026-11-12).
- `npx vitest run tests/unit/codexRolloutLookup-bounded.test.ts`: 20 of 20 pass, three consecutive runs.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a slow test fixture; the wider class, slow test files going unnoticed, is tracked as CMT-1696).
