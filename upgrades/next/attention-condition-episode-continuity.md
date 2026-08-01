# Attention conditions survive process restarts without becoming fake episodes

<!-- bump: patch -->

## What Changed

Stale-owner and rope-recovery notices now use a small durable condition-lifecycle
store. The producers declare structural identity and positive recovery evidence;
the store owns episode numbering.

Restarting the server while a condition is still active therefore reuses the
current Attention episode instead of adding a new row. A later observation only
gets a new episode after the producer has positively observed recovery: the
owner is online or no longer owns a live topic, or the rope has reclaimed
`lastKnownGood`.

Safety and actuation state are unchanged. Stale-owner claim fencing and rope
probe cadence remain process-local and keep their existing conservative reset
behavior; only operator-notice lifecycle is made durable.

## What to Tell Your User

Restarting or updating an agent will no longer make an ongoing stranded-owner or
slow-recovering-network condition look like a brand-new incident. One active
condition stays one queue episode. If the system verifies recovery and the same
condition later returns, that recurrence is still surfaced as a new episode.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Restart-stable Attention episodes for stale owners and recovery probes | Automatic; no configuration or operator action required |
| Honest recurrence after verified recovery | Automatic when the producer observes its positive clear condition |

## Evidence

- The durable-store tests reconstruct the store between observations and prove
  that an active condition keeps one item ID across the simulated restart.
- A clear followed by a new observation increments the episode and produces a
  new item ID.
- Stale-owner tests prove a continuing durable condition emits no second item,
  and authenticated online evidence clears the condition.
- Rope-prober tests prove a continuing durable slow-alive condition emits no
  second item.
- The focused 53-test suite, repository lint suite, and TypeScript build pass.
