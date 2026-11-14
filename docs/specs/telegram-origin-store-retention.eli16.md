# Keeping the Telegram origin store small so replies are never held — plain-English overview

## What this change is

Every Telegram message an agent sends is first written to a small local database called the origin store. It records who wrote the message and whether it arrived. Nothing is sent until that write succeeds.

On the Studio that database has reached 644 MB and keeps growing, because almost nothing is ever removed. The size itself is not what hurts. Once a minute a housekeeping step goes looking for old messages to archive, and on a store this big that search takes 3 to 9 seconds. The store does one thing at a time, so a reply arriving during the search has to wait. Replies only get one second, so the reply is held.

This change makes the housekeeping quick and stops the store growing forever.

## What already exists

There is already a housekeeping step, an archive folder, and a recovery step that delivers held messages later. The archive holds full copies of old records, but it wrote a new file every minute, so the Studio has 18,662 files holding only about 1.4 messages each.

## What is new

- The housekeeping remembers where it got to, instead of re-reading everything each minute.
- Archive files are written in batches of 100 messages, and the old tiny files are merged, a few dozen a minute, until a few hundred remain.
- After seven days, a message's full detail lives only in the archive. A small searchable record stays in the database, so looking up an old message still works.
- The running counters keep their totals, but the long list of individual count events is folded away.
- After a year, the small record and its archive are removed. Anyone reading the history is told how far back it reaches. The limit can be changed.
- Space freed by all this is reused, so the file stops growing. It does not shrink by itself: shrinking took 37 seconds in testing, and sends would be held for that long.

## Safeguards

- Nothing leaves the database until its copy is safely in an archive file. Files are checked before merging, and a damaged one is left alone.
- Messages still being delivered are never touched. Anything not finished stays put.
- The housekeeping does a small amount each minute, takes smaller steps when the disk is slow, and stops early if it runs long, so a reply waits for one small step at most.
- If housekeeping fails, sending carries on as normal.
- A very old message cannot be sent twice just because its details were tidied away.

## What a reader needs to decide

Two choices have a real effect. The first is the 365-day limit on keeping old message history. The original design said to keep it until the operator changes that. This task asks for a limit on everything, so 365 days is the new default. Nothing is removed for about ten months, and the setting can be changed before then.

The second is that the file stays at 644 MB, about half empty, unless someone chooses to shrink it. That costs disk space only.
