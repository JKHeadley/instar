## What Changed

Local Verify checks for a release-note fragment before admitting a pull request that changes source files. It reads later pages of the changed-file list when needed, so a fragment outside the first page still counts. GitHub keeps its normal release and merge checks.

## What to Tell Your User

A source change without a release note now receives an immediate explanation and leaves the testing slot available. Add a Markdown fragment under `upgrades/next/` and offer the new commit for testing. Test-only batches continue to use their usual verification path.

## Summary of New Capabilities

The existing Local Verify request and priority controls report `release-fragment-missing` when admission refuses a source change without a fragment. During a restart, queued changes missing the fragment are dropped before a new run starts.
