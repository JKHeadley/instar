<!-- bump: patch -->

## What Changed

Local Verify retries the affected unit run once when Vitest times out acknowledging saved snapshots and the original report has no failed assertions. The retry gets fresh reports and stays within the total verification deadline. A result can pass only from complete, clean retry evidence.

## What to Tell Your User

A brief interruption in Vitest’s worker communication can now recover without stopping the other test checks. A real assertion failure still fails verification.

## Summary of New Capabilities

None. This improves the reliability of existing Local Verify runs.
