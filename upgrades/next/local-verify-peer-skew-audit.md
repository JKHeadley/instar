## What Changed

Update restarts now wait for a test a helper machine has accepted, normally for up to 21 minutes, so that work is not thrown away. Local Verify also records when it skips a helper machine because that machine runs different test logic, and when the two match again. The skip rule itself is unchanged.

## What to Tell Your User

Nothing for most agents. On machines that share testing with helpers, an update may apply a few minutes later so a running test can finish. If a helper stops taking test work because it is on older code, that now shows up in the logs instead of going unnoticed.

## Summary of New Capabilities

No new user action. Two new log events, `peer-skipped-skew` and `peer-skew-cleared`, appear in the Local Verify audit log, and `restart-held-for-peer` now also covers update restarts.

## Evidence

Unit tests cover one row per version change, one row when the skew ends, and no rows for a matching helper. The first test fails with the call removed. Found live on 2026-11-06: a helper received no work from about 13:13Z with no log entry, while its status read a different verifier hash from the coordinator.

A test through the real updater shows no restart request is written while an accepted attempt runs and one is written after import; it fails with the hold removed. Live before this change: 10 helper attempts lost to restarts between 17:40Z and 01:30Z on 2026-11-06, with 0 holds recorded.
