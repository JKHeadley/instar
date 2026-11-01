# Stabilize macOS package completeness under parallel tests

<!-- bump: patch -->

## What Changed

The package completeness test now uses npm's error log level so its existing retry classifier can see `ENOENT` details. It permits a bounded 16 retries after the initial `npm pack` attempt only for temporary `instar-desktop-capture-test-*` helpers created by a parallel macOS test. Other packaging failures still fail on the first attempt.

## What to Tell Your User

A parallel test timing race no longer turns a healthy macOS full suite red while checking the package.

## Summary of New Capabilities

None. Test behavior only; published package contents are unchanged.

## Evidence

Two M5 full-suite runs of the same commit each had 54,070 unit tests pass and only the package completeness test fail. The package test passed alone. A focused concurrent run with the macOS helper test reproduced npm `ENOENT` for a temporary helper. A further run with the larger retry bound still failed because `npm pack --silent` returned an empty stderr on failure; `--loglevel=error` returned the exact error text. The corrected full-suite result is required before merge.
