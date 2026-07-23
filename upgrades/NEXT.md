# Next Release

## What Changed

Context-wall recovery now distinguishes real session work from leftover helper
processes by observing transcript growth. Waiting no longer consumes recovery
attempts, and a persistent wall cannot defer recovery beyond 30 minutes.

Any respawn while a context-exhaustion latch is active starts fresh instead of
resuming the same overfull conversation. Standby status also reports the
latched wall honestly after its banner scrolls away.

## What to Tell Your User

Long autonomous sessions are less likely to go silently dark at the context
limit. Instar waits when the session is genuinely producing transcript output,
but leftover browser or MCP processes no longer prevent recovery forever. If a
context wall persists, Instar first tries to compact in place and then starts a
fresh session with recent history if needed.

## Summary of New Capabilities

- Transcript-growth evidence for context-wall recovery.
- Deferrals that do not spend the recovery-attempt budget.
- A 30-minute ceiling on persistent context-wall deferral.
- Fresh-only Telegram and Slack respawns while the context latch is active.
- Honest standby reporting for a latched context-exhaustion state.
