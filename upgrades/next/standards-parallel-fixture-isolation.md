# Upgrade Guide — Isolate The Standards Drift Fixture

<!-- bump: patch -->

## What Changed
The stale-build standards test now changes an isolated temporary source document instead of the checkout’s real document. Parallel reader tests cannot observe a temporary extra article. Production audit behavior and the authored standards are unchanged.

## What to Tell Your User
This corrects an unreliable automated check. It does not change setup or importing history; those updates still require normal verification.

## Summary of New Capabilities
None. This is a test-fixture correction.

## Evidence
A complete unit run exposed one 102/103 article-count mismatch while 74,673 tests passed. The reader suite passed all 38 tests alone. The corrected test retains the stale-build refusal, proves the isolated fixture is selected and checks the real source document remains unchanged. The adjacent suites run together before commit.

The corrected adjacent suites passed all 67 tests together. The isolated source uses only guard directories and a synthetic authored-source marker; it does not project package/source identity flags. Normal guarded fixture cleanup passes.
