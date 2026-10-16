# Jev feeds missed corrections to the correction sentinel — plain-English overview

## What this is

The agent has a "correction sentinel": when you correct it, or tell it how you
want things done from now on, the sentinel is supposed to notice, write the
lesson down, and, once the same lesson has come up several times on different
days, start reminding every new session of it.

The problem is how it notices. It only looks at a message if a simple keyword
check flags it first, and that check misses most real corrections. For ten days
we ran Jev (a small, cheap classifier from TypeSafe) beside it, in watch-only
mode. Jev found 40 messages the keyword check missed. About 33 were real
corrections or standing rules from you. The other 7 were notes the agent's own
desk sessions had posted through your Telegram account, each starting "From
Echo …". The sentinel learned from none of the 33.

## What changes

When Jev says a message is a correction or a preference, and the keyword check
missed it, the message is now handed to the sentinel as if the keyword check
had caught it. Two kinds of message are never handed on: notes that start with
"From <the agent's name>" (the desk notes), and messages signed by an agent.

## What stays the same

The sentinel still makes every real decision. Its own model can read the
message and say "this is nothing". A lesson still has to come up several times,
on at least two different days and in at least two different sessions, before
it becomes a reminder. And a reminder is only a hint: any real instruction you
give, or any safety rule, beats it. Jev never blocks, sends or changes a
message.

Jev still writes its watch-only log exactly as before, now with one extra field
saying whether each missed correction was handed to the sentinel or skipped,
and why. The summary page shows those counts.

## Safeguards

- It is switched on only for the development agent (Echo). Every other agent
  has it off unless someone turns it on.
- Off switch: `feedSentinel: false` in the Jev correction settings stops the
  hand-off immediately, without a restart, and keeps the measurement running.
- It only works when the sentinel itself is on and Jev's key is present.
- It uses the sentinel's own daily spending cap, per-conversation rate limit
  and busy-time slowdown, so it cannot run up cost on its own.
- Existing agents get their instructions updated so they can explain the new
  behaviour; the old text saying "this changes nothing the sentinel records"
  is replaced once.

## What a reader needs to decide

Nothing new: the change is covered by the standing approval for Jev work. The
one judgment call worth knowing about is that a Jev-flagged lesson counts
toward the "several times" rule with the same weight as the weakest keyword
hit. Without that, Jev's finds would be written down but could never become
reminders, and the change would do nothing.
