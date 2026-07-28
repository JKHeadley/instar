# Topic-keyed autonomous-mode session identity — Plain-English Overview

> The one-line version: stop recognizing a long-running autonomous job by the worker's badge number (which changes when the worker restarts) and start recognizing it by the address of the house it's working on (which doesn't).

## The problem in one breath

Autonomous mode is supposed to let you walk away while I keep working for hours, never stopping until the job's done. A safety latch enforces that. But when a long run hits the memory limit and restarts, it comes back as a "new" session — and the latch stopped recognizing it as the same worker, quietly let it wander off, and autonomy died for hours with no signal. That actually happened today.

## What already exists

- **Autonomous mode + its stop latch** — while a job is active, the latch refuses to let the session quit and feeds the task back; it only lets go on a time limit, an emergency stop, or a "done" signal. That part works.
- **The topic-to-session address book** — instar already keeps a little registry mapping each chat topic to a fixed work-session name, and when it restarts a crashed session it reuses that same name. So the "address" of a job is already stable and already written down.
- **The job's own notes** — the autonomous job already records which topic it belongs to.

## What this adds

The latch now decides "is this the worker for this job?" by the **topic** (the stable address) instead of the **session ID** (the badge that changes on restart). Because a restarted session comes back at the same address, the latch keeps recognizing it — so autonomy survives the restart instead of silently dying.

- The old badge-matching still exists, but only as a thin backup for the rare case where the address can't be read.
- That backup no longer guesses; it checks whether the previous worker is actually still alive (is its log still growing?) before deciding anything — so it never steals a job from a session that's just busy.
- When a real restart-and-resume happens, you get **one** short heads-up message: "I restarted mid-run and picked the job back up. No action needed." Just once, never repeated.

## The new pieces

- **Topic-keyed ownership** — reads the work-session's name, looks up which topic it serves, and matches that against the job's recorded topic. Match = "I'm the worker, keep going." It is not allowed to trap a session that's working a *different* topic.
- **Liveness backup** — only runs when the address can't be resolved. It checks the previous worker's log freshness; a dead worker's job gets adopted, a live worker's job is left alone.
- **The recovery note** — a one-line, send-once heads-up plus a durable audit record, so a clean recovery is distinguishable from a real death (the exact blind spot that bit us).

## The safeguards

**Prevents the silent death.** A restart no longer looks like a stranger; the job continues.

**Prevents stealing a busy session's work.** The backup only adopts a job whose previous owner is provably stale, and it's only consulted in the rare no-address case.

**Prevents notification spam.** Exactly one recovery note per restart, deduped by recording the new session ID.

**Prevents two old bugs I found in the same latch while I was in there.** One read your UTC timestamps as local time (throwing off the timer math by your clock offset); the other could crash the whole latch if one optional field was missing. Both fixed, with a new fail-safe: if a timestamp is unreadable, the latch keeps the session running rather than risk a premature exit.

**Doesn't assume Telegram.** The recovery note routes to whichever channel the job actually lives on — Telegram is just the one wired option behind a channel-neutral seam, so the design doesn't quietly bake in "Telegram is the only channel." Wiring the other channels (Slack, etc.) for parity is its own dedicated initiative (its own topic), not half-done here.

## What ships when

It's one change, shipped together: the rewritten latch, the safety-net update so existing agents actually receive it, and all three layers of tests (unit, the update path, and a full end-to-end restart-and-resume run). Nothing lands on your live setup until the in-flight overnight run finishes and you say go.

## The decision (settled)

Approved 2026-05-23: recognize the job by its topic, keep the liveness check as a backup, send one recovery note on restart — and route that note channel-neutrally (Telegram wired, no Telegram assumption baked in), with channel parity across all channels split out into its own initiative.
