# Lease-Substrate Robustness — the plain-English version

## The problem in one breath
When one agent runs across two machines, exactly one is "awake" at a time. Which
one is awake is decided by a **lease** — a little signed "I'm in charge" note
written into a shared git repo, that the awake machine has to re-stamp ("renew")
every minute so everyone knows it's still alive.

## What's actually broken
The awake machine DOES re-stamp its note every ~30 seconds — but it stamps a
copy that only lives **in memory / over a direct network ping**, and never writes
the fresh stamp back into the **shared git repo** that everyone else reads. So
the note in the shared repo still says "expires at 12:01" forever. After a minute
it looks expired to anybody else. When a second machine joins (or restarts) and
reads the shared repo, it sees an "expired" note, assumes the first machine died,
and grabs the lease — even though the first machine is alive and well. The result
is the two machines fighting over who's awake.

The original design was: the shared git repo is the durable truth, and the direct
network ping is just a *fast shortcut on top*. The code got it backwards — it used
the fast shortcut *instead of* updating the durable truth.

## The fix
Make renewal **always update the shared git repo** (the durable truth), and use
the fast network ping as an optional extra on top — the inverse of today. Then a
fresh or restarted machine always sees an up-to-date "I'm in charge" note and
won't hijack a live holder. Plus: fix the leftover spots where `git pull` fails
when a branch isn't tracking a remote, and keep the two small fixes already
shipped (renew on a sub-minute timer; pull fresh data before deciding anyone's
dead).

## How we'll know it's fixed
Bring up two real machines with zero hand-holding, watch the shared lease stay
fresh (never expire while the holder's alive), and then do the real demo: you
message the test agent in your own Telegram, a handoff fires mid-reply, and you
get exactly one reply — no drop, no double, no noticing.

## Why it's safe
The change is "write to the durable store on every renewal" — strictly more
information in the shared truth, not less. The split-brain safety gate (the part
that prevents two awake machines) is left exactly as-is. Every piece reverts
cleanly on its own.
