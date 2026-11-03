## What Changed

Some desktop tests started the real packaged Mac desktop helper. macOS records a new Screen Recording / Accessibility entry for every path that runs it, so each test run from a checkout or a Local Verify clone left another "instar-desktop-host" row on the Mac running the tests, and one test asked macOS for permission, which showed real pop-ups.

- `MacDesktopHost` and the lock-state reader now refuse to start the real packaged helper inside a test runner (`VITEST`) unless `INSTAR_REAL_DESKTOP_HELPER_TESTS=1` is set. Fake test helpers have other names and still run.
- The tests that need the real helper run only with that opt-in.

Nothing changes outside a test runner.

## What to Tell Your User

If your Mac's Accessibility or Screen Recording list filled up with many "instar-desktop-host" entries, they came from automated test runs on that Mac and stop being added after this update. Old ones can be removed with the minus button; keep the one at ~/.instar/desktop-helper/instar-desktop-host switched on.

## Evidence

Unit tests for the guard (both sides), plus the fake-helper suites passing with and without a built helper. Independent second-pass review concurred.

## Summary of New Capabilities

None. This removes a side effect of the test suite.
