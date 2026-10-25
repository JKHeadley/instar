# ELI16 — Stop handing conversations to a machine that cannot open one

## The one-sentence version

Instar already refuses to send a conversation to a machine that is out of quota or
whose model connection is failing; it had no way to notice a machine that cannot
open a session at all, so a machine killing every session it started still looked
like the healthiest candidate — idle, unloaded, nothing running.

## Why "idle" was the trap

Placement picks a machine by looking at load, session count, memory pressure, and
an eligibility flag that says "this machine cannot serve model work right now".
That flag already had two causes: the account's quota is exhausted, or the
machine's calls to the model are actually failing.

A machine whose sessions die the instant they start has none of those symptoms. It
has no load, because nothing stays running. It has no sessions, because they all
died. Its quota is untouched, because it never got far enough to spend any. So it
scored *best* and kept being chosen.

## What that cost

On 2026-10-20 two of one machine's logins had never answered Claude Code's
folder-trust question, whose default answer is "No, exit". Every session launched
under them died in sixteen seconds. The operator's conversation had been placed
there. The machine opened a session three times in thirty-five minutes, died three
times, and the conversation never moved — while the operator watched an empty
thread.

## What changed

A third cause on the same eligibility flag, rather than a new system: count
consecutive startup deaths, and past three inside fifteen minutes report the
machine as unable to start work. Placement already knows what to do with that.

Two properties matter more than the counting:

- **One successful start clears it completely.** The machine has just demonstrated
  the exact ability the block was about, so holding a grudge would keep work off a
  machine that works. A recovered machine re-admits itself with nobody doing
  anything.
- **Old failures stop counting.** Two crashes this morning are not tonight's
  verdict, so the window is fifteen minutes.

You are told once per episode, not once per failure, and the notice names the three
usual causes. A machine you deliberately pinned a conversation to is still honoured
— with a reason that names the real problem instead of blaming quota, so you are
not sent to look at the wrong thing.

## If every machine is affected

Placement still places. Somewhere beats nowhere, and the reason travels with the
decision so it can be surfaced rather than hidden.
