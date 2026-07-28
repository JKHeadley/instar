# Multi-session autonomy — Plain-English Overview

> The one-line version: give each topic its own autonomous-job notepad so several can run at once, and add the guardrails that come with running a handful of long jobs in parallel.

## The problem in one breath

Right now I can only run ONE autonomous job at a time. The reason is dumb-simple: an autonomous run is tracked by a single shared notepad on disk. Start a second one and it scribbles over the first, silently breaking it. So I can't, say, autonomously build something on one topic while autonomously testing on another.

## What already exists

- **Autonomous mode + the stop latch** — keeps a session working until its job is done; only lets go on a time limit, a "done" signal, or an emergency stop.
- **Topic-keyed identity (just shipped, v1.2.55)** — an autonomous job is now recognized by its topic (the room it's working in), and the latch already figures out which room it's standing in. This is the foundation the rest builds on.
- **A budget tracker** — instar already knows when it's pushing daily usage limits and can tell jobs "not now."
- **An emergency stop** — "stop everything" already halts the one running job.

## What this adds

The big change: **one notepad per topic** instead of one shared notepad. Then topic A and topic B each run their own autonomous job side by side, and they physically can't collide — different rooms, different notepads. The latch already knows its room, so it just reads that room's notepad.

The rest is the guardrails that only matter once several long jobs can run at once:

- **A cap of 5** running at once (you can change it). Try to start a sixth and I'll say no and tell you what's already running.
- **Budget awareness.** If we're near the daily limit, I refuse to START new ones. Only if we're really over the line do I pause the least-important running one — and I tell you when I do.
- **A rock-solid "stop everything"** that now halts ALL of them at once, plus "stop the one on topic X" for finer control.
- **A way to see what's running** — ask "what autonomous jobs are going?" and get the list, or see it on the dashboard.

## The safeguards

**Nothing collides.** Separate notepads per topic make the old identity-mix-up impossible.

**Nothing runs away.** The cap plus the budget tracker plus stop-everything mean a handful of long jobs can't quietly burn the whole day's usage.

**Nothing breaks mid-flight.** If a job is already running on the old single notepad when this ships, it keeps working and quietly moves to the new per-topic notepad — no interruption.

**Nothing is manual.** Per-topic notepads, the migration, and stop-all are all automatic. You never hand-edit anything.

## What ships when

Three phases, each complete with its own tests: (1) the per-topic notepads + safe handling of any in-flight job; (2) the cap, budget guard, and stop controls; (3) the "what's running" list and the plain-English commands. Existing agents get it all on their next update.

## The decisions (settled)

You picked: cap of **5** (configurable), **per-topic stop ships now**, and for budget pressure you left it my call — v1 refuses to START new jobs when we're near the limit (the main protection), and any running job can be paused under pressure (the off-switch is built in). Whether to add a fully-automatic "pause a running job on its own under heavy pressure" monitor on top of that is a separate judgment call, not part of this first version.

## What you need to decide now

Just whether this design is right. If yes, I write it into the build gate and ship it in the three phases, through to a merged PR — same disciplined path as the fix that just landed.
