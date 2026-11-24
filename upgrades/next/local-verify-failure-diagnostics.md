<!-- bump: patch -->

## What Changed

Local verification retains recent diagnostic details in a failed checkout before removing temporary reports. The private failure file records failed process output, failed test-file messages, and whether the error reporter supplied a count. It keeps the original assertion summary allowance.

## What to Tell Your User

When a verification run fails, the person investigating can now see more of the original error without repeating the run.

## Summary of New Capabilities

Inspect the retained checkout's private `.local-verify-failures.json` for diagnostic details. Its contents may be shortened and may include sensitive test output.
