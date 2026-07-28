# ELI16 — The closeout gets a circuit breaker, and moves ask before pausing real work

## What this actually is

Two fixes from the multi-machine seamlessness plan, both about what happens when a
conversation moves between the agent's machines.

**Fix 1 — the cleanup loop learns to give up gracefully.** When a conversation moves
from machine A to machine B, machine A's leftover session gets closed automatically so
two copies of the agent aren't doing duplicate work. But that close can be VETOED — a
safety guard says "this session is still busy, don't kill it." Before this fix, the
closer just tried again every 2 minutes, forever. On 2026-06-12 that exact loop spent
hours attacking a session that was legitimately working. Now there's a circuit
breaker: after 5 vetoed attempts in a row, the closer stops, writes one audit line,
and raises ONE notice to the operator ("the topic moved to the mini, but the old
session won't close — it's still finishing something"). The session isn't abandoned —
the normal idle cleanup still watches it and closes it the moment it actually
finishes. The breaker resets cleanly if the topic comes back or the session ends.

**Fix 2 — moving a topic asks first when an autonomous run is in flight.** An
autonomous run is the agent working a long job unattended. Before this fix, saying
"move this topic to the mini" would happily yank the conversation out from under that
run mid-task. Now the move pauses and asks: "There's an autonomous run in flight on
this topic, ~90 minutes remaining — move anyway?" If you confirm, the run is paused
at a clean stopping point (the end of its current turn, never mid-thought), and its
progress file is rewritten atomically (a crash can't leave a half-written file) and
travels with the conversation to the new machine, carrying honest markers saying when
it was paused and where it went.

## What already existed

The automatic closeout, its veto guards, the move-by-nickname planner with its two
existing "are you sure?" gates (offline target, mid-reply), and the working-set
carrier that ships a topic's files between machines with hash verification and
torn-file detection. This change adds the missing bound on the closeout loop and the
missing consent + clean-pause for autonomous runs.

## The safeguards, in plain terms

- The breaker only counts REAL vetoed close attempts — a busy hour where the closer
  simply didn't get a turn can't trip it.
- One notice per episode, deduplicated — never a flood.
- The pause keeps the run's file on disk (a stop deletes it; a move must not).
- "Already on that machine" never asks — there's nothing to interrupt.
- Everything is reversible: one config number restores the old retry behavior, and a
  paused run file can be re-activated by hand.

## What you need to decide

Nothing — both pieces are part of the approved multi-machine plan. The bigger
machinery for fully draining a live session across machines (the "drain signal" with
its own authorization) is the next item in this workstream and builds on top of this.

## Shipped so far in this workstream

WS4.2 empty-state honesty, WS3 one-voice election, WS1.3 ownership reconcile,
WS1.1 dispatch-to-owner hardening — and now the WS1.2 breaker + WS1.4 run guard.
