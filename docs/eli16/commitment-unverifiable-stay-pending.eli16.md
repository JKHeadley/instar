# Unverifiable promises stay open — ELI16

When the agent makes a promise it can't machine-verify ("I'll review that PR
when it lands", "I'll follow up after the build"), it registers a commitment so
the system can nag it into following through. That nagging is the entire point:
a reminder beacon beats on open commitments, and an overdue sweep surfaces the
stale ones.

The bug: the verification sweep, finding no automated way to check such a
promise, marked it DELIVERED about 75 seconds after creation — "trusting agent
acknowledgment." And delivered is a terminal state: the beacon never beats for
it, the overdue sweep never surfaces it, and nothing — not even the documented
override — can re-open it. The promise didn't fail loudly; it silently ceased
to exist while reporting success. Today that ate a real promise whose
condition (a PR that hadn't been opened yet) couldn't possibly have been
fulfilled in 75 seconds.

The history matters: that auto-delivery was itself a fix — one old commitment
had accumulated 51,000+ "violation" ticks because every sweep re-flagged it,
and auto-delivering stopped the spam. A later fix kept beacon-enabled promises
open, but everything registered through the plain API still fell through. So
two prior fixes each solved their incident and left a hole.

This fix generalizes the later one: ANY unverifiable promise is now a strict
no-op for the sweep — never violated (the spam class stays dead, because a
no-op adds no ticks), never auto-delivered (the evaporation class dies too).
It closes only by an explicit delivery, an explicit edit, or its own expiry —
and stays visible and nagging until then, which is what a promise should do.
A second back-door got the same treatment: a boot-time cleanup intended for
old violation-spammed rows was terminalizing ALL pending unverifiable promises
at every restart — its code now matches what its own comment always said it
did (only rows with accumulated violations and zero verifications).
