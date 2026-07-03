# The worktree auto-cleaner now actually runs — plain-English overview

## What this is

Instar has a built-in janitor (the AgentWorktreeReaper) whose job is to clean up leftover "worktrees" — full copies of the source code that get created for each piece of development work. Each copy is big (hundreds of megabytes), and when nobody cleans them up they pile into tens of gigabytes of dead weight that also makes macOS file indexing churn the CPU.

The janitor was designed carefully: it only ever removes a copy whose work is finished and fully saved in git (merged + no unsaved changes + nothing currently using it), it double-checks everything, and it refuses to touch anything ambiguous. It was switched ON on the machine that had the problem. And yet 86 leftover copies totaling 25GB piled up anyway.

## What was actually broken

The janitor's alarm clock. When the server starts, the janitor set exactly one timer: "run me in 24 hours." But real agent servers restart much more often than once a day — updates, reboots, recoveries. Every restart threw away the old timer and set a fresh "in 24 hours" one. So the janitor never reached its first shift. Ever. The feature looked on, reported healthy, and did nothing — for weeks.

## The fix

One small change: when the server starts, the janitor now also sets a second, one-time alarm for **15 minutes after boot**. It runs one cleaning pass then, and the normal every-24-hours schedule continues unchanged. Fifteen minutes is deliberate — right after boot the machine is busy, so the janitor waits for things to calm down.

Nothing about WHAT the janitor may delete changed. Same safety rules (never touch unsaved or unmerged work, never touch anything in use), same limit of 20 removals per pass, same circuit breaker if a removal keeps failing, and the feature still ships switched OFF with dry-run on — nothing happens on any machine unless an operator has deliberately enabled it.

## Safeguards, in plain terms

- **The delete rules are untouched.** This change only fixes WHEN the janitor wakes up, never WHAT it's allowed to remove.
- **Off by default, exactly as before.** Machines that never enabled the janitor see zero change.
- **A kill switch that needs no code change:** set the initial-pass delay to 0 in config and you're back to the exact old behavior.
- **It can't pile up on itself:** if a pass is somehow still running when another starts, the second one simply does nothing.
- **Tested:** seven new automated tests cover the new alarm (fires once at the right time, respects dry-run, cancels cleanly on shutdown, doesn't exist when the feature is off, and the 24-hour schedule is unchanged).

## What you need to decide

Nothing — this is a Tier-1 (small, low-risk) fix riding the normal review-on-PR process. If you run a machine with the reaper enabled, expect one cleaning pass about 15 minutes after each server start; the report at `GET /worktrees/agent-reaper` now also shows whether that first pass is still pending.
