# In plain English: make the one-time token re-labeling quick instead of choppy

## What this is about

The agent keeps a database of token usage. Old rows are labeled "unknown" until a
one-time background job re-labels them with which part of the agent spent them.
A recent fix made sure this job runs AFTER the agent has started up, so it can no
longer freeze the agent on boot. This change fixes HOW that background job does
its work, so it never freezes the agent at all — not even briefly.

## What was still slow

The job worked "by group": it found each distinct combination of
(chat-session, project, model) and then ran one database command per group that
said "change every unknown row matching this group." The problem: each of those
commands had to scan through ALL the unknown rows to find its matches. With
hundreds of groups and hundreds of thousands of unknown rows, that's a huge
amount of repeated scanning.

On the real database that caused the original incident (202 MB, ~390,000 unknown
rows), each batch took about **23 seconds** of solid work. Because the database
library does its work all-at-once (it can't pause mid-command), the agent was
frozen for those 23 seconds each time a batch ran. After boot, so it wasn't
fatal — but a 23-second freeze is still bad, and it would repeat until the job
finished.

## What's new

Instead of working "by group," the job now works "by row." It grabs a batch of
unknown rows directly, figures out each one's label, and updates each row by its
exact internal ID (which is instant — no scanning). Two rows from the same group
still get the same label, so the final result is exactly the same as before — it
just gets there without the repeated scanning.

The difference is dramatic: on that same 202 MB database, a batch of 1,000 rows
now takes about **5 milliseconds** instead of 23 seconds, and re-labeling all
390,000 rows finishes in about 14 seconds total, in tiny non-blocking steps.

## What the reader needs to decide

Nothing to configure. Token labels end up identical; the work just stops causing
freezes. A test proves a single group with several rows now updates in row-sized
batches (not all-at-once) and that every row still ends with the correct shared
label, and the real-database run confirms the speed at scale. This finishes the
performance story started by the boot fix.
