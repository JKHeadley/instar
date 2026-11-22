# A rebuild that cannot finish keeps your messages — Plain-English Overview

> The one-line version: the command that rebuilds an agent's message history from
> its logs could delete every message and then fail half-way through putting them
> back, and this makes that impossible to lose data on.

## The problem in one breath

Every instar agent keeps a searchable copy of its own conversations in a small
local database, built from the plain-text logs the agent writes as messages
arrive. There is a maintenance command that throws that copy away and rebuilds it
from the logs. If the rebuild hits a line it cannot store, it stops — and because
the throwing-away happens first, the agent is left with no message history at all
and an error message that does not say what was lost.

## What already exists

- **The message logs** — one line of text per message, written as each message
  arrives, one file per channel (one for Telegram, one for Slack). These are the
  source of truth, and this change does not touch them.
- **The searchable copy** — a local database of the same messages, which is what
  the agent actually reads from when it needs context or searches its history.
- **The rebuild command** — throws away the searchable copy and re-reads every
  log to build it again. It is manual and rare: an operator runs it when the copy
  looks wrong.
- **A guard added earlier in November** — before deleting anything, the rebuild
  now reads every log and COUNTS how many messages it could put back. If the
  answer is zero while the database holds messages, it refuses to delete and says
  so. That guard was added because the rebuild used to empty a store and report
  success, which looked exactly like a rebuild that worked.

The counting guard is the important piece, and the reason it works is that it
asks the SAME question the real import asks, with the same code. One question,
asked twice, so the count cannot promise something the import will not deliver.

## What this adds

The count and the import had drifted apart on one point, and nobody noticed
because the code really is shared: the shared question was simply incomplete. It
asked "does this line have text, and can I work out which conversation it belongs
to?" It never asked "does this line have a TIME on it?" — and the database
refuses, absolutely, to store a message with no time, because a message with no
time cannot be put in order or counted as the latest thing in a conversation.

So a line with text, a channel, and no time was counted as restorable. The guard
saw a positive number, allowed the delete, and the import then hit the database's
refusal and stopped with the history already gone. This was measured on the
current code, and the failure reproduces: the store ends up with zero messages.

Two changes:

- **The shared question now asks about time too.** A line with no time is
  counted as unusable, exactly as a line with no text already was. Nothing is
  lost by this: a line like that could never be stored in the first place — one
  path dropped it silently and the other crashed on it — so refusing it earlier
  only stops the guard from counting something that was never going to arrive.
- **The delete can now be undone.** Before deleting, the rebuild keeps a private
  copy of the messages it is about to remove. If anything at all goes wrong while
  putting the messages back, the copy goes back in, the agent logs that the
  rebuild failed and nothing was lost, and the original error is passed on
  unchanged. The private copy is thrown away either way at the end.

The second change matters more than the first, because the first only fixes the
one cause that was measured. The second covers any cause at all — a different
missing field, a disk error, a clash between two messages — without needing
someone to find it first.

## The new pieces

- **The time check** — one line in the function that decides whether a logged
  line can become a stored message. It refuses only a MISSING time, not an odd
  one: a line with an empty or strange time still stores today, and still does,
  because the database accepts those and this change is not the place to argue
  about them.
- **The held copy** — a private, temporary table that exists only for the few
  seconds between the delete and the end of the restore, and only inside the
  single connection doing the work. Nothing else can read it, it cannot outlive
  the process, and it is deleted on both the success and the failure path.
- **A named failure reason** — when a rebuild is rolled back, the report the
  command leaves behind says `restore-failed-rolled-back` and says that zero rows
  were deleted, so a later reader can tell a rolled-back rebuild from a refused
  one and from one that worked.

## The safeguards

**Prevents the measured data loss.** With the time check in place, a log holding
only time-less lines now makes the rebuild REFUSE to delete, with the messages
still in the store, instead of emptying it and crashing. This is pinned by a test
that fails on the current code and passes with the change.

**Prevents the same shape of loss from any other cause.** The held copy is not
keyed to the missing-time problem. A test deliberately makes the restore fail
for an unrelated reason, part-way through, and checks that the store afterwards
holds EXACTLY the messages it held before — not none of them, and not a
half-finished import. That test fails on the current code too.

**Prevents a quiet success.** A rolled-back rebuild reports itself as not having
rebuilt, logs the real cause, and re-raises the original error. The earlier work
on this command exists because a failure once looked like a success; nothing here
reintroduces that.

**Does not pretend to cover everything.** If the process is KILLED outright
mid-rebuild — a crash or a power cut rather than an error — the held copy dies
with it and the store is left as the import left it. That gap is written into the
code at the point where someone would look for it, because covering it properly
needs a copy that survives a restart plus a rule for what a second process should
do if it opens the same store mid-rebuild, and that is a decision this change
does not quietly make.

## What ships when

One change, one commit: the time check, the undo, and the tests ship together.
The undo is only trustworthy if a test proves the delete comes back, and the test
only proves anything if it fails on the code as it stands — so splitting them
would ship a claim without its evidence.

## What you actually need to decide

Is "hold a copy of the rows for the length of the restore, and put them back if
anything throws" the right shape for making this rebuild safe — or should the
rebuild instead build the new copy first and swap it in at the end, which is a
larger change to the same function?
