# A message that was never stored no longer reports itself as stored — Plain-English Overview

## The problem in one breath

Instar keeps a searchable copy of every conversation message in a small SQLite
database. The function that writes one of those rows reported "inserted" without
ever checking whether a row had actually been written. If the database quietly
refused the row, the function still said "inserted", and everything downstream
believed it.

## How the database can quietly refuse a row

The write uses SQLite's `INSERT OR IGNORE`. That instruction means: if this row
breaks a rule, drop it and say nothing. It was chosen so that writing the same
message twice is harmless. The cost is that it treats every other broken rule the
same way — a missing piece of text, a value the table will not accept — by
writing nothing and raising no error. From the calling code, a dropped row and a
successful write looked identical.

Measured on the current code, with the real database and the real schema:

    insert a row whose text is missing
      -> the function answers "inserted"
      -> rows actually in the table: 0
      -> the topic's own message counter: 1

## Why it matters

Two places count that answer. The row writer adds one to its "inserted" tally and
tells its caller the write succeeded. The log importer adds one to "imported", and
that number is what the rebuild endpoint reports back as the number of messages
restored. So a message that is not in the database could be counted as stored, in
a store whose own documentation promises it "never ignores silently, so the caller
can count it". Nothing anywhere recorded that the message was missing.

## What this changes

The write now reads the database's own answer — how many rows it actually wrote —
and passes that up truthfully:

- the low-level insert returns whether a new row landed;
- the keyed insert reports `not-landed` instead of `inserted` when nothing landed;
- the row writer treats that as a refusal, exactly as it already treats the two
  other ways a row can be turned away. It counts it and files a degradation report
  naming the message that is missing;
- the importer counts those rows separately from the ones it imported, and that
  count reaches the two places anyone would read it: the warning line printed at
  the end of an import, and the `/topic/rebuild` response.

## What this deliberately does NOT do

It does not catch anything. If the database is unwritable or corrupt, the write
still throws, loudly, exactly as it does today. That distinction is the whole
history of this item: an earlier patch tried to fix it by catching the failure
inside the write, and that turned a loud failure into a *counted success* on both
consumers — a worse report than the crash it replaced. It was retired unshipped.
Two tests in this change exist to keep the two apart, one of which reads the
source code and fails if either function ever grows a `catch`.

## What you actually need to decide

Nothing, to take this. One thing is left open on purpose and is written down in a
test rather than left to be rediscovered: the topic's message counter is still
incremented for a row that did not land, so two readings of the same store differ
by one. It is corrected whenever the store is rebuilt from the message table, and
the line that would fix it is also the line that throws today — so changing it is
its own decision with its own evidence, not a side effect of this one.
