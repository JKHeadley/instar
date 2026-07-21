# ELI16 — Remember one fact after the banner scrolls away

Instar already knows how to recognize Claude Code's real context-limit banner. It also already has one recovery engine that decides whether it is safe to act, waits through its existing cooldown, limits attempts, tries `/compact`, and can respawn the session. This change does not redesign any of that.

The failure is simpler: the monitor sees only the latest terminal lines. It can see the real banner on one poll, then lose sight of it after more output scrolls the banner upward. Losing the visible banner currently also loses the fact that the trusted detector already matched it.

The fix remembers exactly one fact per topic: `wedgedSeen=true`. The value is written only after the existing detector matches one of its existing patterns. It survives a server restart in SessionRecovery's existing state file. It has no timestamp, pattern copy, session mapping, confidence score, retry counter, or expiry. It cannot recognize anything new and cannot take action itself.

On later ordinary monitor polls, that remembered true value lets the same SessionRecovery engine inspect and handle the topic even if the banner is no longer in the captured tail. All of SessionRecovery's existing ownership, active-work, cooldown, attempt, compact, and respawn rules still decide what happens. A failed or deferred result leaves the fact remembered but creates no timer or retry. The monitor's existing poll and cooldown remain the only presentation rhythm.

The boolean clears only when the existing engine reports genuine recovery (`recovered:true`) or when an operator uses the explicit manual-clear seam. It never disappears because an hour passed. This makes the banner observation durable without turning the latch into a second detector, validator, scheduler, or recovery engine.
