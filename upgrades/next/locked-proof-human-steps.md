## What Changed

Internal: Correct locked-Mac proof human-step sequencing. User-switch checks wait for departure, dwell and return; logout starts the watch and confirms departure/old producer exit before the login cue. Delayed unlock cues use the recorded watch start and new observations. Switch/logout native lock-call evidence remains explicitly unmeasured. No live proof or rollout readiness claimed.
Human cues now require a confirmed full Telegram receipt (or explicit console-only mode), carry case/run and START BY times, and fail on partial, unknown or late delivery. No automatic resend. The visible deadline does not cancel messages held by the transport.
The first relevant human action must also be observed before START BY. Repeated-unlock cases wait for the initial locked watch before cueing and require a fresh first unlock, without claiming to count all manual repetitions.

## What to Tell Your User

The instructions for the locked-Mac checks now include a deadline and wait for the requested action to be observed. Ignore a cue that arrives late or belongs to a stopped test. These are test-runner corrections; locked-screen access is not enabled by this change.

## Summary of New Capabilities

None. Existing proof steps now reject unconfirmed messages and stale or late action evidence.

## Evidence

147 targeted unit tests pass across the human-step, delivery, driver and proof-build files. Hardware proof and full Local Verify remain required before rollout.
