# ELI16 overview — Turn-End Self-Deferral Guard

## What this is, in one breath

A quiet watcher that notices when I (the agent) end a turn by handing YOU a decision about work I could
just do myself — the "want me to line that up, or would you rather steer me elsewhere?" move — and
writes it down so we can measure how often I do it. In this first phase it **only watches; it never
blocks or changes a message.**

## Why we need it

On 2026-07-04 I did exactly this and nothing caught it. The message wasn't a tool call, didn't match any
banned phrase, and ended with a polite either/or question that the meaning-based rules are told to allow.
The one check smart enough to catch it — a meaning-based judge — wasn't watching the turn-end surface at
all. So a well-worded "your call?" that's really me punting doable work sails straight through every
guard. This closes that specific blind spot.

## What already exists (that this builds on)

There is already a meaning-based judge that runs at the end of every turn (the "stop gate," which today
catches a different problem — me quitting on myself for a fake reason). It already has a place to record
what it sees (a small local database). This design REUSES that one judge and that one database — no new
model, no new call, no new hook.

## What's new (Phase A — the part we're building now)

- One new thing the judge can recognize: "this message handed the operator agent-ownable work"
  (`U_SELF_DEFERRAL`), plus a few fields describing how confident it is.
- The judge now reads a little recent conversation (your last few messages) so it can tell a genuine
  "your call" (taste, priority, a credential only you have) from me punting work I should just do.
- It records each verdict to the existing database.
- **It blocks nothing.** Every message ends exactly as it would have. This is pure measurement.

## What is deliberately NOT in this phase

The "actively stop me mid-message" version. That's genuinely hard and risky — chiefly: how to make it
impossible for me to quietly switch off or game, and how to guarantee it never wrongly blocks you. It's
deferred to a separate design with its own hard preconditions (spec §10), to be decided only after the
watch-only version produces real data.

## What the reader needs to decide

The operator already made the two decisions this needed: (1) direction — build the watch-only version
first, then consider blocking later ("soak then graduate"); (2) go-ahead to build the watch-only version
now. Both are recorded. The blocking version remains a future, separately-approved decision.

## Why it's safe

It rides the one check that already runs, only adds data on the "allow" path, never touches the blocking
logic, and is off on the fleet by default (on only for a development agent, so it soaks on one agent
first). When off, behavior is byte-for-byte identical — even the shared judge's prompt input is
untouched. The recent-conversation read is bounded and fail-open (it can't hang or crash a turn), and
the only new stored state is a few extra columns in an existing local database, with a real prune so it
can't grow forever.
