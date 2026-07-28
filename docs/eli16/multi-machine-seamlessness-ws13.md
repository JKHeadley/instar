# Conversations That Finish Their Move — Plain-English Overview

## The problem we lived through today

This morning we moved a live conversation from the laptop to the Mac Mini and then
back. The "back" half never finished: for HOURS the system's two sources of truth
disagreed — the sticky note said "this belongs on the laptop" while the ownership
record still said "the Mini has it." Nothing existed to settle the argument; the
fix was documented as "it resolves on the next message," but the next message
never took that path. Meanwhile the cleanup robot, reading only the ownership
half, tried to close the laptop's working session every two minutes, held off
solely by its safety guards.

## The fix

A reconciler now runs on every machine and settles pin/owner disagreements within
a bounded time, politely when possible and forcefully only with proof:

- **If the current owner is alive**, it hands the conversation over properly —
  finish what you're doing (with a deadline), pass the baton, the new machine
  picks it up. Nobody ever steals from a living machine, no matter how slow it is.
- **Only if the owner is provably dead** — offline past a hard evidence bound, and
  only when the deciding machine is in the majority of the pool — does the new
  machine take the record by force, with a numbered fence the dead machine cannot
  override if it comes back confused.
- **The dashboard tells the truth meanwhile**: a half-moved conversation now shows
  as "pending move since <time>" instead of silently contradicting itself.
- **The cleanup robot got smarter**: when the sticky note says a conversation is
  coming BACK to this machine, it stops attacking the session here and waits.

Built for Phase C from day one: the "majority of the pool" math works for any
number of machines — cloud VMs included — not just two Macs on a desk.

## What changes for you

Nothing yet — it ships dark, and even when enabled it starts in rehearsal mode
(logging what it WOULD do without doing it). Once proven and turned on: "move this
conversation" finishes every time, within a minute or two, and you can always see
honestly where a move stands.
