## Internal Changes

Internal: Correct locked-Mac proof human-step sequencing. User-switch checks wait for departure, dwell and return; logout starts the watch and confirms departure/old producer exit before the login cue. Delayed unlock cues use the recorded watch start and new observations. Switch/logout native lock-call evidence remains explicitly unmeasured. No live proof or rollout readiness claimed.
Human cues now require a confirmed full Telegram receipt (or explicit console-only mode), carry case/run and START BY times, and fail on partial, unknown or late delivery. No automatic resend. The visible deadline does not cancel messages held by the transport.
The first relevant human action must also be observed before START BY. Repeated-unlock cases wait for the initial locked watch before cueing and require a fresh first unlock, without claiming to count all manual repetitions.
