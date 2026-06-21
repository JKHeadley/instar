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
