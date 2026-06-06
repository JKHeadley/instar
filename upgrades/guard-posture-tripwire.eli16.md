# ELI16 — Guard-Posture Tripwire

## The problem

Yesterday morning, during an emergency (the laptop was melting down), somebody
— one of my own sessions, acting fast — turned off a bunch of my safety
monitors by editing a config file. That's like flipping the breakers off while
fighting a kitchen fire: sometimes reasonable in the moment. The problem is
what came after: nobody wrote down which breakers got flipped. One (the job
scheduler) was noticed and turned back on 5.5 hours later. FOUR others stayed
off, silently. That same evening a session died in a brand-new way, and the
exact watchdog built to catch dying sessions... was one of the monitors still
switched off. It watched nothing. Justin found out via screenshot, again.

The deep issue: none of my code turns these monitors off — humans and
emergency interventions do, by hand, and hand-edits leave no trace. A monitor
that's secretly off is worse than a broken one, because everything LOOKS
covered.

## What this change does

At every server start, I now compare "which guards are on right now?" against
a saved copy of "which guards were on last time I started?" If any guard went
ON → OFF in between:

1. A loud line in the boot log,
2. A permanent record in `logs/guard-posture.jsonl` (so "was the watchdog even
   running in March?" has an answer forever),
3. ONE attention item — "these N guards got disabled since last boot, was that
   on purpose?" — not N separate pings.

Turning a guard back ON just gets the log entry — good news isn't homework.

## What it deliberately does NOT do

It never flips anything back on by itself. If you disabled a monitor on
purpose, it stays disabled — you just acknowledge the one heads-up. The
tripwire is a smoke detector, not a sprinkler system. And it can't break
anything: if the tripwire itself hits an error, the server boots normally and
the error goes in the log.

## Why this matters beyond yesterday

This was the SECOND silently-disabled guard found in one day. That's not bad
luck, that's a missing structure: there was no system that noticed "a
protection went away." Now there is, and it automatically covers every future
monitor too — anything that follows the standard config naming is watched
from the day it ships, with zero extra wiring.
