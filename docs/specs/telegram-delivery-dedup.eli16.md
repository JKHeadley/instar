# ELI16 — Telegram delivery-chokepoint dedup

## What this is, in plain English

When you send your agent a message on Telegram, it travels through a relay and finally gets
"handed" to the actual running agent session (a terminal program). Normally that hand-off
happens once per message.

But we caught a glitch: I sent one agent (Codey) a single task message, and the relay handed
it to the session **five times** in about fifty seconds — because the session was just
starting up and the relay kept re-trying before it was ready. The agent then saw the same
task over and over and started queuing it up to do five times. That's wasted work and wasted
model usage (which costs real quota), and it's confusing.

## What already exists

The relay does dedupe at the *polling* layer (it remembers the last message number it pulled
from Telegram, so it won't pull the same one twice). But the final hand-off step — the place
that actually writes the message into the running session — had no such memory. So if
anything upstream handed it the same message more than once, the session got it more than
once.

## What's new

The hand-off step now keeps a tiny short-term memory of "which exact message did I already
give to which session." Every Telegram message has a unique number. If the same message
number is about to be handed to the same session again within ten minutes, the hand-off
quietly skips it and writes a note in the log instead. The agent gets the message exactly
once.

Important details:
- The very first hand-off always goes through — only the *repeats* are skipped.
- Two genuinely different messages are never confused (they have different numbers).
- If a message somehow has no number (some internal paths), nothing is deduped — old
  behavior is preserved.
- We deliberately keep logging the duplicate so we can still hunt down *why* the relay
  over-handed it in the first place. This change is the safety net, not the root fix.

## Why it's done at this spot

There are a couple of paths a Telegram message can travel, but they all funnel through the
same single hand-off function before reaching the session. Putting the guard there means it
protects every path at once, no matter which one over-handed the message.
