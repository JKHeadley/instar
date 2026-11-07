## What Changed

Feedback sorting now keeps processing new reports when its separate daily allowance for retrying older reports has been used. Older retry rows stay queued until that allowance resets. The total daily call limit remains in force.

## Summary of New Capabilities

None; this corrects the existing feedback sorting schedule.

## What to Tell Your User

New reports can still be sorted after the retry allowance is used, provided the main daily allowance and model account are available. Waiting retries resume after the allowance resets.

## Evidence

The regression reproduced an older truncated retry blocking a new report, then passed after the fix. Full integration, end-to-end and CI results are required before release.
