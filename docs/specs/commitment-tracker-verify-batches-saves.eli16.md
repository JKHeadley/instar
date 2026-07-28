# ELI16 — CommitmentTracker saves once per check, not once per item

Your agent keeps a to-do list of promises it made you ("commitments"), saved in a file
on disk. Once a minute it goes down the whole list and checks each item.

The bug: **every single time it touched one item, it re-saved the entire file.** When the
list had grown big (on the affected machine it was 1.6 megabytes — about 1,700 items, most
of them already finished and never cleaned up), one pass down the list saved that whole 1.6MB
file *hundreds of times in a row*, back to back.

A program like this has one main "worker" that can only do one thing at a time. Saving a
1.6MB file hundreds of times with no break ties up that worker for *minutes*. While it's
tied up, the agent can't answer "are you alive?" health checks — so a safety watchdog thinks
it crashed and restarts it. Then it boots, does the same thing, and gets restarted again. A
restart loop.

The fix: while it's going down the list, it **holds off on saving** and just remembers "I
need to save." When it finishes the whole pass, it saves **once**. So instead of hundreds of
saves per minute it does one. (It also stops "pretty-printing" the file with extra spaces,
which only made the file bigger and slower to write — nothing reads it by eye.)

Nothing about your commitments changes — what's tracked, what's saved, how it all works is
identical. The agent just stops doing hundreds of pointless identical saves every minute, so
it no longer freezes on that cadence.
# ELI16 — DegradationReporter no longer melts down when it can't reach a model

Your agent has a "something degraded" reporter. When an internal feature falls back to a
backup (say a sentinel's preferred AI tool isn't installed, so it uses a different one), the
reporter notes it and — before messaging you — runs the note past a small "tone gate" to make
sure the wording is friendly.

Here's the trap. That tone gate is itself a tiny AI call. And it goes through the same router
that just degraded. So if the configured tool is missing, running the tone gate **degrades
again** — which tells the reporter "something degraded" — which runs the tone gate — which
degrades again… round and round, in one unbroken loop. Every loop adds another entry to a list
the reporter keeps, and the reporter periodically turns that whole list into text (a
`JSON.stringify`). The list grows so huge that turning it into text takes **minutes**, and
during those minutes the agent's single worker can do nothing else — health checks fail, a
watchdog thinks it crashed and restarts it, and it does the same thing again. That restart loop
was the "flapping."

The fix is one sentence of logic: **the tone gate refuses to run while it's already running.**
So if checking a degradation alert triggers another degradation, that inner one just uses a
plain safe message instead of recursing. The loop can't form — no matter which tool is missing.
As a belt-and-suspenders, the list of degradation events is now capped at a fixed size, so even
a steady drip of real degradations can never grow it without limit.

Nothing about what you see changes — degradations are still logged and you're still alerted.
The agent just stops eating itself alive when a configured tool isn't there.

