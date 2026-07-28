# Semantic Memory Corruption Recovery — Plain-English Overview

## What this is about

The agent keeps a small searchable database of things it has learned — names,
facts, and how they connect. That database is a file on disk. Sometimes a file
like that can get damaged: the power blips, the disk hiccups, or a write gets cut
off halfway. If the agent just tried to use a damaged file, it could crash on every
startup. So we built an automatic safety net.

## What already exists

Every time the agent opens that memory database, it runs two quick health checks:

1. A built-in integrity check that SQLite (the database engine) provides.
2. A "probe read" — it actually reads a few rows out of each table, because the
   first check can miss certain kinds of damage deep inside the file.

If either check finds real damage, the agent does the safe thing: it sets the
damaged file aside (renamed, not deleted, so we can inspect it later), drops a small
marker file so a human can see a recovery happened, and rebuilds a fresh database
from the agent's plain-text memory log (which is the real source of truth). The
agent keeps running the whole time — it never crashes on a bad file.

## What's new in this change

We found a case where the safety net was *too* eager. The memory database can hold a
special "vector" table used for similarity search. That table needs an optional
add-on (an extension called vec0) to be readable. But the probe-read check runs
*before* that add-on is loaded — so reading the vector table failed with "no such
module: vec0," and the agent mistook that for file damage. The result: it threw away
and rebuilt the database on *every single startup*, piling up junk files and never
letting similarity search settle.

The fix teaches the probe to tell the two situations apart. A missing add-on is not
the same as a damaged file. The probe now skips the special vector table (its real
data lives in ordinary helper tables that are still checked), and any "missing
add-on" error is treated as "this feature just isn't loaded yet," not "the file is
broken." Genuine damage is still caught and still triggers the safe rebuild.

## What you need to decide

Nothing new to approve — this is a bug fix that makes the existing, already-approved
safety net behave correctly. After it shipped, the rebuild-on-every-startup loop
stopped, and similarity search came back to life on the affected agent. If you ever
want the old behavior back, it is a one-line revert with no data-format change.
