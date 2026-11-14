# Auto-expiry review ledger — plain-English overview

## What this is

Instar has two clean-up sweeps. One closes old promises the agent made
("commitments"). The other removes old self-improvement to-do items ("evolution
actions"). Both run in practice mode by default: they count what they would
close, but close nothing. Someone is supposed to look at what they would close,
decide it is right, and only then switch practice mode off.

That review was impossible. The sweeps only printed totals like "412 would
expire". They never wrote down which ones, so there was nothing to look at.

## What changes

1. **A written list.** Every sweep now writes a line to a log file listing
   exactly which records it would close (or did close), how old each is, and
   why it qualified. If the list is the same as last time, it writes a short
   "unchanged" line instead of repeating the whole list.
2. **Promises that are waiting on someone are left alone.** A promise marked as
   waiting on an outside party or on the operator is no longer treated as
   simply "old". Those already have their own handling.
3. **No more guessing that old means done.** The old closing note said the
   promise was "presumed completed". That was a guess. Now the note either
   quotes the reason the promise was created without a follow-up, or says
   plainly that the outcome is unknown.
4. **A promise the agent is still checking on is not "old".** Age now counts
   from the last time the agent checked the dependency, not only from creation.
5. **The to-do sweep is more careful.** High-priority items are kept, and an
   item with a due date is only eligible once it has been overdue for the full
   three weeks, not the moment it passes its date. On this agent that drops the
   candidates from 44 to 17.

## What stays the same

Both sweeps are still in practice mode by default. Nothing new gets closed
because of this change. Turning practice mode off is still a deliberate choice,
and now it can be made by reading an actual list.

## What you need to decide

Nothing right now. Later, when reviewing whether to switch either sweep on for
real, read the latest full line of its log file and check the ids.
