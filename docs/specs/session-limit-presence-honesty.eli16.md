# "Actively working" while actually paused — fixed (the plain-English version)

One night your conversation sat on a machine whose Claude session had hit its
limit — the terminal literally said "Session limit reached ∙ resets 10:30pm" —
and yet the standby watcher kept telling you "echo is actively working on
something." You waited on a machine that was doing nothing.

The watcher already knew how to be honest about this: when it sees a
quota-limit banner in the session's terminal, it's supposed to say "the agent
has hit its usage limit, the session is paused, no work is being done" — with
the reset time. The bug was narrower and dumber: the newer banner WORDING
wasn't in its list of recognizable phrases. It knew "You've hit your limit -
resets 7pm (America/Los_Angeles)" but not "Session limit reached ∙ resets
10:30pm" (no timezone in parentheses, different phrasing) — so it fell back to
the generic "actively working" line.

The fix adds the missing wordings: "session limit reached", "session limit …
resets …", and any limit banner with a bare "resets 10:30pm" (no timezone).
"Approaching session limit" deliberately does NOT trigger it — approaching
isn't paused, and the session is still working then.

What you'll see now: if a session is paused on its limit, every standby
message says exactly that — paused, no work happening, resets at HH:MM —
instead of pretending it's busy. That honest message already feeds all three
check-in tiers (the 20-second, 2-minute, and 5-minute updates), so the very
first thing you hear is the truth.
