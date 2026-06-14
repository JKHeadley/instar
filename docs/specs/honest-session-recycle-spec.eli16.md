# Honest Session Recycle — plain-English overview

## What this is, in one line

When a long autonomous run's session hits its built-in "recycle" point and the
system restarts it to keep going, the user should NOT get a scary tombstone
message claiming the session "reached its maximum allowed runtime" — because the
run isn't over, it's just being handed to a fresh process.

## The problem we hit (real, 2026-06-14)

An agent had an autonomous run going with about 11.5 hours left on its 24-hour
clock. Each underlying terminal session, though, has its OWN much shorter
lifetime cap (a few hours), after which the system kills the old process and
spins up a fresh one that picks up exactly where it left off (a "recycle"). No
work is lost — it's like swapping a tired runner for a fresh one mid-relay.

But the message the user saw was: **"🪦 Your session was shut down — it reached
its maximum allowed runtime."** At the very same moment, the run's own clock said
"11h 42m remaining." Two messages, flatly contradicting each other. To the user
it looked like their sessions keep dying for no reason — which is exactly the
frustration that kicked this off.

## What already exists

The notifier that sends "your session was shut down" messages ALREADY knows how
to stay quiet for a routine "kill-and-respawn" — it just wasn't told that an
age-limit recycle of a still-active autonomous run is one of those. So the fix
rides an existing seam rather than inventing a new system.

## What's new

1. When a session is recycled at its lifetime cap, we check: does this session's
   topic have an autonomous run that is still inside its window? If yes, we stamp
   the event as a recycle and how much time is left on the run.
2. The notice then tells the truth: **"🔄 Your session was recycled at its
   lifetime cap — your autonomous run has 11h 42m left, so I'll pick the work
   back up where I left off. No work was lost."** No tombstone, no false
   "maximum runtime" claim.

## The safeguards, in plain terms

- **We never go silent.** If anything goes wrong reading the run state, or the
  run is genuinely over, the user still gets the normal loud "shut down" notice.
  We only ever soften the wording when we are sure the run is still alive — we
  never hide a real stop.
- **Only the recycle case is touched.** A session that died because it got stuck
  (not because of its age cap) still gets the honest "it was stuck" message, even
  mid-run.
- **No behavior change.** This changes words on a notice and adds one fact to an
  event. It does NOT change when sessions get recycled, or whether they respawn.

## What we deliberately did NOT do yet

There's a stronger version where the system simply doesn't recycle a run at its
midpoint at all (it respects the longer run clock). We held that back on purpose:
it's only safe once we've proven the run is GUARANTEED to auto-respawn on its own,
and today the respawn is triggered by the next message. That bigger change is
tracked (commitment CMT-1520), not forgotten.

## What you (the reader) actually need to decide

Nothing is required to ship this — it's wording-only and can't hide a real
failure. The one judgment call already made: ship the honest-wording fix now,
and treat "stop recycling mid-run entirely" as a tracked follow-up gated on
verifying guaranteed auto-respawn. If you'd rather hold even the wording change,
say so; otherwise it's safe to land.
