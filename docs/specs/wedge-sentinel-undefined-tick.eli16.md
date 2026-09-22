# A missing setting made a background checker run a thousand times a second — plain English

## What went wrong

Instar runs a background checker that looks for one specific kind of stuck
session. It is meant to glance at each live chat session every 20 seconds.

The code that starts it passes along the timing from the agent's settings. When
the settings don't mention a timing — which is how instar ships them — it passes
"no value". The checker then merged its own defaults with what it was handed in
a way that let "no value" overwrite the 20-second default. With no interval,
the computer's timer runs the checker as fast as it can: about every millisecond.

Every run reads the screen of every live chat session, and the server waits for
each read to finish. On the inspec agent — five live conversations — the server
spent about 78% of its time just waiting on those reads. Everything else slowed
down with it. The worst casualty was Telegram: each outgoing reply needs a
permission slip that expires after a quarter of a second, and a server that
busy kept missing it. The reply was then parked for about 15 minutes before the
next try. That is why inspec's replies arrived 5–25 minutes late and out of
order.

## What this change does

1. **Fixes the checker.** A missing timing value now falls back to the
   20-second default, and a timing below one second is raised to one second. So
   the checker can never spin, whatever its settings say.
2. **Fixes the whole family of this bug, not just this one case.** The same
   "no value overwrites the default" mistake existed in 98 places across instar.
   One of them had already caused a crash once before and was patched on its own.
   96 of them now use one small shared helper where a missing value can never
   erase a default. The last 2 sit in a specially protected file that can only
   change after a fresh live test. They only ever read settings files, which
   can't contain a missing value, so they're safe until then. They're tracked for
   that next test.
3. **Stops it coming back.** A new automated check runs with instar's other
   code checks and refuses new code that merges settings the fragile way. It reads
   code the way the TypeScript compiler does, so unusual code in a file can't
   make it skip that file.

## What already exists vs. what's new

Everything the checker does is unchanged: same detection, same recovery, same
alerts. Only its timing is repaired. The conversions keep exact behaviour
for every value that is actually set; the only difference is that a missing
value keeps the default instead of wiping it out.

## Safeguards

- Tests reproduce the exact incident: settings that turn the checker on with no
  timing. The old code fails them; the new code passes.
- The new automated check has its own tests covering the shapes it must catch
  and the ones it must leave alone. It also scans the real codebase and must
  come back clean.
- Nothing here stores data or changes any agent's saved settings, so undoing it
  is just reverting the code.

## What you need to decide

Nothing. This restores the behaviour everyone already assumed they had. The
stopgap already on the machine (adding the timing to each agent's settings)
becomes unnecessary once agents update, and is harmless to leave in place.
