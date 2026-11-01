# Console Tests Clock Pin

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Two dashboard page tests (Plans and Promises) built their fixtures around a
fixed date (2026-10-25) while the page under test read the real clock. Once the
real date passed seven days after the fixture date, the Plans test's three
"in flight" plans aged into "idle" and the test failed on every run, turning main
red. The Promises test had the same defect and would have tripped within weeks.
Both DOM test blocks now pin only `Date` to the fixture date (timers stay real),
so they pass on any day. Test-only change; no shipped code moves.

## Evidence

- Before: `tests/unit/console-plans.test.ts` failed on main e48d40419
  ("expected to have a length of 3 but got 0" at line 295).
- After: both files pass (45/45). Run with the process clock shifted +90 and
  +400 days they still pass, and all 17 console page test files pass (326/326)
  at +400 days.
