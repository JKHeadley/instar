# Side-Effects Review — test runs stop touching the Mac's privacy lists

**Version / slug:** `desktop-tests-stop-touching-tcc`
**Date:** `2026-11-02`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Operator report 2026-11-02 10:37 (topic 134088, with a photo): "instar-desktop-host" entries kept appearing in the Studio's Accessibility list after he removed them, plus a "tmux would like to access data from other apps" pop-up. Cause: desktop tests ran the real packaged helper (`dist/native/instar-desktop-host`) from each checkout / Local Verify clone. macOS keys privacy entries by path, so each run added a row; `desktop-own-identity` also runs `request-permission`, which raises real prompts.

Changes:
1. `src/core/MacDesktopHost.ts`: `packagedBinary()` throws `mac-desktop-host-test-guard` when `VITEST` is set, `INSTAR_REAL_DESKTOP_HELPER_TESTS` is not `1`, and the resolved binary is the real packaged helper. Logic in the exported pure function `realHelperBlockedUnderTest`.
2. `tests/e2e/desktop-own-identity.test.ts`, `tests/e2e/desktop-helper-retention-lifecycle.test.ts`: skip unless the opt-in is set (they spawn the binary directly or build their own signed copies, so the host guard alone does not cover them).
3. `tests/e2e/desktop-boot-lifecycle.test.ts`: the three live-Mac-target cases skip unless the opt-in is set. `tests/unit/desktop-helper-state-op.test.ts` (spawns the real binary to decide whether to skip) gets the same gate.
5. `src/core/MachineLockStateReader.ts`: its default probe, the one other direct spawn of the real helper, applies the same rule and reports "cannot run" (null) under a test runner.
4. `tests/unit/desktop-real-helper-test-guard.test.ts`: both sides of the guard.

6. `src/server/routes.ts` `GET /desktop/locked/status`: when the helper's locked state cannot be read (helper missing, refused, invalid), it answers 503 with a reason code instead of leaving the request hanging. Found by Local Verify: with the guard, the e2e test's request hung for 30 s (408). The real-helper case of `desktop-locked-lifecycle` is now opt-in; a new non-opt-in case checks the route answers.

## Decision-point inventory

- `realHelperBlockedUnderTest` — add — invariant: a test runner never starts the real packaged helper without an explicit opt-in. Deterministic by design: the harm (a permanent privacy-list row on the operator's Mac, real pop-ups) lands the moment the binary runs.

## 1. Over-block

Under a test runner, any code path that starts the real packaged helper now fails with `mac-desktop-host-test-guard` instead of running. The comparison uses the expected path, not a resolved one, so fake helpers in `dist/native` still run on a Mac where the real helper was never built (the second-pass review caught an earlier draft that resolved the real path and failed when it was missing). Tests that relied on the real helper are exactly the ones now opt-in gated; route-wiring assertions in the other desktop e2e files tolerate an unavailable probe (they already run on Linux CI where the helper does not exist). Production (no `VITEST`) is unaffected.

## 2. Under-block

A test that copies the helper to a new name and runs it (as the retention test does) is not caught by the host guard; that test is gated by the env opt-in instead. A future test doing the same would not be caught structurally; the unit test documents the rule, and the opt-in name is greppable.

Coverage that now runs only with the opt-in: the own-identity re-exec check, the signed kept-copy retention lifecycle, the live Mac target on the production route, and the helper state verb. These were already Mac-only (never on Linux CI). They need a deliberate opt-in run on a Mac set aside for it; tracked as commitment CMT-1241 (run them on the Laptop test user during the locked-Mac proof sitting).

## 3. Level-of-abstraction fit

The host's `packagedBinary()` is the single place every real-helper spawn resolves through (probe, capture, input, indicator, relock guard), so one check covers all verbs.

## 4. Signal vs authority compliance

The guard is a hard refusal, but only inside a test runner and only for one exact path; it gates no user-facing behaviour. Reference: docs/signal-vs-authority.md.

## 5. Interactions

`DesktopHelperRetention` is already disabled under a test runner, so no kept copy is used in tests; the guard covers the packaged fallback. No interaction with Local Verify beyond fewer rows on the verifying Mac.

## 6. External surfaces

Removes an external side effect of the test suite (privacy-list rows, permission prompts on the operator's Mac). No runtime surface changes.

## 7. Multi-machine posture

Machine-local by design (`hardware-bound-resource`: a Mac's privacy database is per machine). Every Mac that runs tests benefits independently.

## 8. Rollback cost

Revert the commit. Rows would start appearing again on test-running Macs; no data or state to repair.

## Second-pass review

**Reviewer:** independent reviewer subagent (two rounds, 2026-11-02)

Round 1 raised a concern: the guard resolved the default helper path on disk, so every fake-helper test failed on a Mac without a built helper (43 of 70), and `desktop-helper-state-op.test.ts` plus `MachineLockStateReader`'s default probe still ran the real helper. All three were fixed. Round 2: "Concur with the review" — fake-helper and guard tests 70/70 with and without a built helper; state-op, lock-state and watch-only tests 27 passed, 6 skipped (opt-in). Noted, no action: a symlink at the default path pointing to another name would pass the guard; nothing creates one.

Follow-up (route fix, item 6): independent reviewer — Concur with the review. Only `status()` is inside the try; the error passes through only when it matches the `mac-desktop-host-*` code shape, else a fixed code; success and pool paths unchanged; the test split is sound (the new case proves the route answers, not that a 503 happens, which is its job).
