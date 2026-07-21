# Context-wedge seen latch

## What Changed

SessionRecovery now persists a true-or-absent `wedgedSeen` flag per topic after the existing context-exhaustion detector matches. If the banner later scrolls outside the monitor's capture tail, ordinary monitor polls continue presenting the remembered observation to the same recovery engine. Successful recovery or explicit manual intervention clears it.

No detector pattern, timer, TTL, session mapping, retry policy, active-work guard, attempt cap, compaction step, respawn step, or recovery authority changed.

## Evidence

- Focused SessionMonitor and context-exhaustion recovery suites cover 71 assertions.
- Persistence tests prove true-only state survives reconstruction, preserves attempt rows, clears on existing recovery success, and supports explicit manual clear.
- TypeScript build passes.

## What to Tell Your User

Instar is less likely to forget a context-limit failure merely because its banner scrolled out of the visible terminal tail. Existing recovery safety rules remain unchanged.

## Summary of New Capabilities

- Durable memory of an already-detected context wedge, scoped per topic.
- Automatic clearing on genuine recovery and an explicit manual-clear seam.
