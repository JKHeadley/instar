# Diagnosis peer test no longer collides on a fixed temp path

## What Changed
The test used a fixed attempt id, so its temp folder was always the same path in `/tmp`. A folder left there by another account made five of its eight tests fail for everyone on that machine. It now uses a unique id per run.

## What to Tell Your User
Nothing to tell; this only changes a test.

## Summary of New Capabilities
None; this only changes a test.

## Evidence
Before: 5 failed, 3 passed, with `/tmp/lv-1111…` owned by the `_instarharness` account. After: 8 of 8 passed, with that folder still present.
