# A delivered agent session no longer reports a false launch failure

## What Changed

A headless session launch creates the live terminal process with its full instruction first, then writes a session record for monitoring. If that record write failed, the launch method used to reject even though the new agent was already running the instruction. Callers could then retry the same work into a second live session.

The post-launch record write is now classified as degraded bookkeeping: it is logged and structurally reported with the exact session identity, but the already-live session is returned as success. Real failures before the terminal session exists still reject exactly as before. The interactive reroute path is unchanged because it injects its instruction only after persistence, so a write failure there does not prove delivery.

The tradeoff is explicit: if the first record write fails, the live terminal session is outside normal monitoring and automatic reaping and may survive restart until manually cleaned up. Reporting the launch as failed would not fix that orphan; it would additionally invite a second agent to run the same instruction. The identified orphan is the safer and observable outcome.

## Evidence

The new regression forces the session-state write to throw after one successful captured tmux launch. Against the unfixed source, the suite produced 25 passes and one failure: the simulated bookkeeping exception escaped. With the fix, all 26 tests pass, and the regression proves one launch, the exact prompt in that launch, a live session, and a resolved result.

Adjacent verification passed 131/131 assertions across headless spawn behavior, spawn-request queue behavior, framework portability, interactive session caps, and silent-fallback enforcement. `npm run lint` also passed, including TypeScript checking and the complete repository lint chain.

## What to Tell Your User

If one agent starts work handed to it by another agent, it will no longer claim the start failed merely because the monitoring record could not be saved afterward. That prevents the sender from launching the same instruction twice while keeping the bookkeeping problem visible for diagnosis.

## Summary of New Capabilities

No new capability, endpoint, setting, or operator action. This corrects the success/failure boundary of existing headless session launches. Rollback is a single revert with no state migration.
