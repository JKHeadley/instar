## What Changed

Under the subscription-path reroute (`intelligence.subscriptionPath.mode: force`), ordinary spawns (conversations, builders, A2A) now leave one rerouted slot for confined feedback-executor spawns, in addition to the slot they already left for scheduler jobs, once `maxRerouted` is 4 or more and the feedback executor runs live (enabled, not dry-run) and owns the queue on that machine. A confined spawn may use every slot but the scheduler's. Hosts with fewer than 4 slots, and every agent not running the executor, keep the old behavior. The total cap and the memory-pressure gate are unchanged.

## Evidence

On the operated Studio, 2026-11-12 from 16:00 PST: the feedback executor used 0 of 12 daily starts; every tick refused `reroute-capacity`. The server log at 18:31 shows `Cannot reroute: rerouted-session cap reached (7/7)` after `maxRerouted` had been raised from 6 to 8 and the server restarted around 18:04: other builder sessions filled the new slots. After (unit level, tests/unit/session-manager-confined-reroute.test.ts): with 4 slots, two ordinary spawns leave the third refused, a confined spawn is admitted, a second confined spawn is refused, and a scheduler job still gets the last slot; with 3 slots ordinary spawns keep their old limit.

## What to Tell Your User

If your agent runs automated fix workers for feedback, other sessions can no longer use up every session slot and stop those workers from starting. One slot is kept free for them, the same way one is already kept free for scheduled jobs.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| A reserved session slot for feedback fix workers | Automatic while the feedback executor runs live and `maxRerouted` is 4 or more |
