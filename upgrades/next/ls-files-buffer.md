<!-- bump: patch -->

## What Changed

A repository test read the list of every tracked file with Node's default 1 MB limit. The list passed 1 MB today, which failed that test on `main` and on every pull request. It now allows 64 MB. No runtime change.

## What to Tell Your User

Nothing changes for you.

## Summary of New Capabilities

None.

## Evidence

`tests/unit/audit-convergence-reports.test.ts` failed with `spawnSync git ENOBUFS` on a merge with `main`, where the list is 1,048,674 bytes, and passes with this change.
