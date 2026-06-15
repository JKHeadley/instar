# ELI16 — Stop the agent from thinking the computer slept when it was just busy

## The one-sentence version

When the computer is moderately busy, the agent sometimes *thinks the machine fell asleep for ~25 seconds* — even though it didn't — and that false alarm kicks off a disruptive recovery (restart the tunnel, reconnect Slack, hand the conversation to the other machine). This change teaches the "did we just sleep?" detector to recognize that *repeated* short jumps on a *busy* machine are busyness, not sleep — so it stops crying wolf.

## What's going on today

The agent has a tiny background check that runs every 2 seconds. It works by looking at the clock: if 2 seconds were *supposed* to pass between checks but the clock jumped forward ~25 seconds, the agent concludes "the operating system must have suspended me — the machine slept, and I just woke up." On a real laptop sleep that's exactly right, and waking up needs a cleanup (reconnect everything).

The problem: when the machine's CPU is **oversubscribed** (more work than cores), that same 2-second timer *also* fires late — not because the machine slept, but because the processor was too busy to get to it on time. From the inside, "the machine slept 25s" and "the machine was too busy to run me for 25s" look **identical** — both just look like "the clock jumped."

So on a busy machine the detector **false-fires**, and each false alarm triggers the full wake-up cleanup. That cleanup is heavy: it restarts the tunnel, reconnects Slack, reshuffles which machine is "in charge," and can bounce the live conversation to the other machine. That cascade is what shows up to the user as: a reply that's lost the thread, messages that get no answer, and "typing is disabled."

There are already three guards meant to catch this, but they share one blind spot — a *middle band of busyness*:

1. One guard suppresses the jump only when the machine is **very** overloaded (more than 1.5× the number of cores). At a *moderate* overload — say 1.1× cores — it stays silent.
2. Another guard suppresses jumps that come **back-to-back**. But the real false cycle is ~2 **minutes** apart, with lots of normal on-time ticks in between that reset its counter — so each late tick looks like a lonely, innocent event and slips through.
3. The rate-limiter only blocks a repeat within **1 minute** — and the false cycle is ~2 minutes apart, so it sails past.

The measured incident: load sitting around **1.1× cores** (below the 1.5 guard) with a false "wake" firing about **every 2 minutes** while the machine was actively in use. All three existing guards missed it.

## What's new

One cheap, extra sanity-check before the detector declares "we slept" on a *short* jump:

**"Did this just happen recently, on a busy machine?"** — The detector now remembers *when* the last short clock-jump happened (a timestamp, not just a back-to-back counter). If another short jump happened within the last 5 minutes **and** the machine is currently oversubscribed (load above 1× cores), it treats the new short jump as "the machine is just busy," not sleep. A healthy machine doesn't genuinely sleep-and-wake over and over every couple of minutes — repeated short jumps *while busy* are the fingerprint of an overloaded machine, not a sleepy one.

The "while busy" part is what makes this safe: on a quiet or lightly-loaded machine, repeated short sleeps are still treated as real sleeps and still recover normally. The new check only ever kicks in inside that middle band of busyness the old guards left open.

## What's deliberately unchanged (the safety net)

- A **long** jump (5 minutes or more) is *always* still treated as a real sleep and always wakes up properly — an overnight sleep recovers exactly like before.
- A **single, isolated** short sleep still fires normally — close the lid for 30 seconds once, and it still does its cleanup.
- On a **light or idle** machine, even *repeated* short sleeps still fire — the new check requires the machine to be oversubscribed, so normal laptops are unaffected.
- There's an **off switch** (set the window to `0`) that restores the old behavior exactly — the instant rollback if anything misbehaves.
- The bias is intentionally toward **staying quiet** when unsure *in the busy band*: a missed real wake just means a connection refreshes a little later (on the next message), which is mild; a false wake triggers the whole disruptive cascade, which is the bug.

## A named follow-on (not shipped here)

A second, complementary check — "were we awake the whole time?" (suppress a jump that overlaps a real incoming message) — is a sensible future addition. It is **not** in this change: the recurrence check alone closes the measured gap, and shipping unused, unwired code now would be clutter. It's recorded as the next increment, not quietly dropped.

## What you actually need to decide

This is a bug fix to a detector that's currently causing real disruption on busy machines. The trade-off: in exchange for stopping the false-alarm cascade, the detector will, in rare cases on an *already-overloaded* machine, stay quiet on a *second* genuinely-short sleep within 5 minutes of another jump (its connections then refresh on the next activity instead of immediately). Given the cascade it prevents is far more disruptive than that mild edge case — it only applies while busy, and there's an instant off-switch — the trade is strongly worth it.
