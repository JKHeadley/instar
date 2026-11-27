# Use project approval when testing managed Codex startup

The managed Codex startup test now asks the real project round runner which work is approved before it launches. The runner checks for one active approved action, the owner's acknowledgment for that round, an explicit machine owner, and no recorded blocker. If those checks pass, it returns the exact action and record revisions for the dispatcher to recheck before letting Codex proceed.

This is part of the off-by-default rollout. The round runner's answer identifies eligible work. A live launcher must also reserve the execution claim and verify the worker and current conversation ownership. The disposable test takes the action through the dispatcher and native Stop path. Ordinary project rounds still use their current launcher, and this change does not move work between machines or enable live managed continuation.
