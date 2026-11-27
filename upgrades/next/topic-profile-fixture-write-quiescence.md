# Upgrade Guide — Let Test Writes Finish Before Cleanup

<!-- bump: patch -->

## What Changed
Two topic-profile test cases now wait for the durable failure-recording write to finish before removing their temporary files. Their existing failed-stop assertions remain unchanged. Production behavior is unchanged.

## What to Tell Your User
This repairs an unreliable automated check. The setup and history-import changes still need normal coordinated verification before publication.

## Summary of New Capabilities
None. This repairs test cleanup.

## Evidence
The complete search unit run exposed a nonempty-directory cleanup failure while the detached breaker write was still active. The corrected cases wait for the existing audit emitted after that write commits. All 57 focused topic-profile tests passed before this commit; complete verification must run through the shared coordinator.
