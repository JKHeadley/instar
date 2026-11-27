# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The feedback-triage lifecycle end-to-end test now waits up to 30 seconds for its background drain and triage ticks, instead of a fixed loop of about 2 seconds. It names the stalled step and its last observed state if one does not finish. Test-only; no shipped behavior changes.

## Evidence

Main b2f53172 failed this file on a loaded Studio (e2e shard 1332 s against a recorded 7.3 s), with no assertion message retained. The file passes on its exact head (recorded in the PR).
