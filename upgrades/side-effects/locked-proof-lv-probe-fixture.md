# Inert helper answers the probe (Local Verify fix)

## Summary

Tier 1. Test-only change: two test files, five lines. No product source, helper, configuration or route changes.

## Local Verify fix (2026-11-18)

Local Verify on head 393d15158 failed one e2e test, `tests/e2e/desktop-locked-lifecycle.test.ts` ("wires native actor diagnostics from production boot through exact child exit"). The test was wrong, not the code.

Cause: `GET /desktop/locked/status` probes the desktop helper before it reads the locked store (`desktopLockedLevers().status` calls `access.probe()` for the macOS version). The test's inert helper (`tests/fixtures/native-observation/isolation.ts`) answered every unknown verb, including `probe`, with `{}`. `MacDesktopHost.probeAs` rejects that reply (`mac-desktop-host-probe-invalid`), so the route answered 503 and the test's `expect(before.status).toBe(200)` failed. The route's behaviour is the same on main and was not changed by this PR; the test only runs on macOS, so it first ran on the Studio's verify.

Fix: the inert helper now answers `probe` with a valid, unready reading (no permissions, no displays, no session). The fixture's unit test now asserts that `host.probe()` resolves through the inert helper. With the old fixture that new assertion fails with the same `mac-desktop-host-probe-invalid` error, so the cause is reproduced at unit level without running the e2e lane by hand.

## Effects and verification

Only test code changes. The unready probe keeps every desktop readiness path closed, so the test still never reaches a real permission, display or the operator's desktop store. `tests/unit/native-observation-isolation.test.ts` and `tests/unit/desktop-guard-observation.test.ts` pass (8 tests). The e2e file is left to Local Verify. Reverting this commit restores the 503 and the red e2e test.
