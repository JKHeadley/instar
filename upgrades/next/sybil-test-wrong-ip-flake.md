## What Changed

- A network-security test that could fail by coincidence for an hour at a time now uses a harder puzzle, so it no longer blocks merges. No product code changed.

## What to Tell Your User

Nothing visible changed; this only keeps the automated checks reliable.

## Evidence

- The test failed 4 of 4 runs on main at the time; with the change it passed 3 of 3 runs, 16 of 16 tests.

## Summary of New Capabilities

None.
