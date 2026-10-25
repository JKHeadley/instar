# The conversations that fell off the bottom of the page — Plain-English Overview

> The one-line version: the part of instar that learns "which conversations does this
> machine own?" was reading only the first page of a list sorted worst-first for its
> purpose, so young conversations were invisible to it — and an invisible conversation
> can never be handed between machines.

## The problem in one breath

An operator pinned a conversation to a different machine. The pin was recorded. The move
never happened — for four hours, with no error surfaced and no self-healing. Both machines
were behaving correctly and neither was lying. They simply were not reading the same page.

## What already exists

- **A shared ledger of handovers.** Every time a conversation changes hands between
  machines, a row is appended to a journal that replicates to every machine. The row says
  "conversation N is now owned by machine M, at handover number E."
- **A handover counter per conversation.** That number ("epoch") starts at 1 and goes up by
  one each time the conversation moves. A conversation that has bounced between machines
  for months sits in the hundreds; one created this morning sits at 1 or 2.
- **A step that turns ledger rows into local records.** Each machine periodically reads the
  ledger and writes itself a local ownership record. This step exists precisely because a
  machine cannot own something it has no record of.
- **A handover procedure that checks that record.** When machine A asks machine B to hand a
  conversation over, B first checks its own record. No record means B answers, truthfully,
  "I don't have this" — and refuses.

## What was actually broken

The ledger read is **paged**, and for this kind of row it is sorted by the handover counter,
**highest first**. The reader returns at most 500 rows per page. The ownership step asked
for one page and stopped.

So the step was seeing "the 500 most-handed-over rows", not "the 500 most recent". A young
conversation sits at the bottom of that ordering by construction. Once the ledger held 500
rows with higher counters, a new conversation was simply not in the page — and the cutoff
only ever rises as the ledger grows, so this gets worse over time and hits the *newest*
conversations hardest.

Measured on a live machine on 2026-09-05: one page showed **33** conversations; walking
every page showed **150**. The step was seeing 22% of them. The conversation the operator
was trying to move (counter: 2) was below the page's cutoff (counter: 6), so its machine
never wrote itself an ownership record, so every handover attempt was refused with
"not-owner" — twice, three hours apart, identically.

## What changes

The ownership step now walks **every** page instead of the first one, using the paging
cursor the reader already provides. Nothing about the ledger, its ordering, or its cursor
changes — only how much of it this one reader consumes.

## The safeguards, in plain terms

- **It cannot run forever.** The walk stops after a fixed number of pages (40, about 20,000
  rows — far more than the ledger ever holds) and says so if it ever hits that ceiling.
- **It cannot spin in place.** If the cursor ever fails to advance, or fails to build, the
  walk stops and logs why rather than looping.
- **It cannot go quiet about doing less.** If it is ever handed a reader with no paging
  support, it reads one page — the old behaviour — and *says so in the log*. A silent
  under-read is the bug itself; it must never be reachable silently again.
- **It changes no decisions.** This step only copies an already-decided fact from the ledger
  into a local record. It does not decide ownership, and this change gives it no new
  authority — it only lets it see rows it was always meant to see.

## What this does not fix

There is a **second**, independent limit in the same family: the reader also reads at most
the newest 500 rows of each individual ledger *file*, before any paging happens. Measured:
one file with 700 rows exposes only 500, even walking every page. It is not biting yet — the live
files hold 384, 383 and 249 rows — but I measured how fast they grow rather than assuming,
and the busiest one gains about 22 rows a day with 116 to spare, so it crosses the limit in
roughly **five days**. The other two are about 23 and 77 days out. That is tracked as
**ACT-1811** (high priority, due within the week), and it needs its own spec because raising
that limit changes the memory cost of every read of this ledger.

## What you actually need to decide

Whether walking the whole ledger on a periodic background tick is an acceptable cost for
correctness here. The honest numbers: the walk is bounded at 40 pages, runs off the routing
hot path on a 15-second timer, and on the live journal completes in 3 pages. The alternative
— leaving it — means new conversations keep silently becoming unmovable between machines,
with the failure appearing as a refusal that names no cause.
