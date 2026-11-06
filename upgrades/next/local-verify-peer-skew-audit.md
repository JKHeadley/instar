## What Changed

Local Verify now records when it skips a helper machine because that machine runs different test logic, and records when the two match again. The skip rule itself is unchanged.

## What to Tell Your User

Nothing changes in how testing behaves. If a helper machine stops taking test work because it is on older code, that now shows up in the logs instead of going unnoticed.

## Summary of New Capabilities

No new user action. Two new log events, `peer-skipped-skew` and `peer-skew-cleared`, appear in the Local Verify audit log.

## Evidence

Unit tests cover one row per version change, one row when the skew ends, and no rows for a matching helper. The first test fails with the call removed. Found live on 2026-11-06: a helper received no work from about 13:13Z with no log entry, while its status read a different verifier hash from the coordinator.
