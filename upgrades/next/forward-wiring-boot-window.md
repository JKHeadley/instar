## What Changed

A paired machine no longer holds its automatic Telegram notices in the first seconds after a restart. Sends wait (at most 30 s) until forward-to-holder routing is wired, then go to the lease holder.

## What to Tell Your User

If you run me on more than one machine, notices I send right after a restart no longer get stuck as "held"; they may just arrive a few seconds later.

## Summary of New Capabilities

No new capability. Reliability fix for multi-machine Telegram delivery right after a restart.

## Evidence

The Mama PC held automatic notices at 2026-11-01 07:09Z and 09:14:45Z (boot at 09:14:33Z), before forward wiring existed. New unit tests cover the wait and its 30 s bound.
