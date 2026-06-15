# ELI16 — Stop the agent from thinking the computer slept when it didn't

## The one-sentence version

When the computer is very busy, the agent sometimes *thinks the machine fell asleep for ~25 seconds* — even though it didn't — and that false alarm kicks off a disruptive recovery (restart the tunnel, reconnect Slack, hand the conversation to the other machine). This change teaches the "did we just sleep?" detector to tell a *busy machine* apart from a *sleeping machine*, so it stops crying wolf.

## What's going on today

The agent has a tiny background check that runs every 2 seconds. It works by looking at the clock: if 2 seconds were *supposed* to pass between checks but the clock jumped forward ~25 seconds, the agent concludes "the operating system must have suspended me — the machine slept, and I just woke up." On a real laptop sleep that's exactly right, and waking up needs a cleanup (reconnect everything).

The problem: when the machine's CPU is **maxed out** (too many things running at once), that same 2-second timer *also* fires late — not because the machine slept, but because the processor was too busy to get to it. From the inside, "the machine slept 25s" and "the machine was too busy to run me for 25s" look **identical** — both just look like "the clock jumped."

So on a saturated machine the detector **false-fires** roughly every 2 minutes, and each false alarm triggers the full wake-up cleanup. That cleanup is heavy: it restarts the tunnel, reconnects Slack, reshuffles which machine is "in charge," and can bounce the live conversation to the other machine. That cascade is what shows up to the user as: a reply that's lost the thread, messages that get no answer, and "typing is disabled."

There are already a couple of guards meant to catch this, but they have a blind spot: the main one only triggers when the late ticks come *back-to-back*. The real false cycle is ~2 **minutes** apart, with lots of normal ticks in between that reset the counter — so each late tick looks like a lonely, innocent event and slips through.

## What's new

Two cheap, extra sanity-checks before the detector declares "we slept" on a *short* jump:

1. **"Did this just happen recently?"** — It now remembers *when* the last clock-jump happened (a timestamp, not just a back-to-back counter). If another jump happened in the last 5 minutes, it treats the new short jump as "the machine is just busy," not sleep. A healthy machine doesn't genuinely sleep-and-wake over and over every couple of minutes — repeated short jumps are the fingerprint of a *busy* machine, not a sleepy one.

2. **"Were we awake the whole time?"** — If the agent saw real activity (a message coming in) during the window the "sleep" supposedly happened, then the machine was obviously awake, so the jump was busyness, not sleep. (This one only switches on if it's wired to the activity signal; without it, it simply does nothing — no change.)

## What's deliberately unchanged (the safety net)

- A **long** jump (5 minutes or more) is *always* still treated as a real sleep and always wakes up properly — an overnight sleep recovers exactly like before.
- A **single, isolated** short sleep after a quiet stretch still fires normally — close the lid for 30 seconds once, and it still does its cleanup.
- Both new checks have an **off switch** (set their window to `0`) that restores the old behavior exactly — the instant rollback if anything misbehaves.
- The bias is intentionally toward **staying quiet** when unsure: a *missed* real wake just means a connection refreshes a little later (on the next message), which is mild; a *false* wake triggers the whole disruptive cascade, which is the bug. So when in doubt, suppress.

## What you actually need to decide

This is a bug fix to a detector that's currently causing real disruption on busy machines. The decision is whether the trade-off above is acceptable: in exchange for stopping the false-alarm cascade, the detector will, in rare cases, stay quiet on a *second* genuinely-short sleep that happens within 5 minutes of another jump (its connections then refresh on the next activity instead of immediately). Given the cascade it prevents is far more disruptive than that mild edge case — and there's an instant off-switch — the trade is strongly worth it.
