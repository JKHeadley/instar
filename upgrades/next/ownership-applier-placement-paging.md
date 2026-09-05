# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The step that turns replicated handover rows into a machine's own ownership records
read only the FIRST page of the placement journal. That query is ordered
epoch-descending and clamped to 500 rows, so one page is "the 500 most-handed-over
rows", not the 500 most recent. A young conversation — one that has changed hands
once or twice — sits at the bottom of that ordering by construction, so once the
journal held 500 higher-epoch rows it was simply not in the page. The cutoff only
rises as the journal grows, which makes this worse over time and aimed squarely at
the newest conversations.

Measured on a live machine: one page exposed 33 distinct topics, an exhaustive
cursor walk of the same journal exposed 150 — the step was seeing 22% of them. The
consequence is not cosmetic. A topic that is never materialized leaves its owner
machine with no ownership record, so a handover request is answered `not-owner` and
refused. A pinned cross-machine move then cannot land, and nothing self-heals it: the
transfer's own place-repair is deliberately illegal against an active record, so the
two machines deadlock — one holding a record the other has never seen. Observed live
as a ~4-hour `pinState: diverged` with two identical refusals three hours apart.

The applier now walks every page using the reader's existing keyset cursor. The
journal, its ordering, and its cursor contract are untouched — only how much of it
this one consumer reads. Termination is driven by an EMPTY page rather than a short
one, because the reader clamps `limit` to its own cap and a "short page" test would
have stopped the walk after page one, reproducing the very bug. The walk is capped at
40 pages, stops if the cursor fails to advance or to build, and a reader with no
cursor support degrades to one page while SAYING SO in the log — a silent under-read
is the defect itself and is no longer reachable quietly.

Known and tracked, not fixed here: the reader also reads at most the newest 500 rows
of each individual stream FILE, before paging. Measured — a 700-row file exposes 500
even under exhaustive paging. Measured growth: the busiest stream holds 384 rows and
grows 21.8 rows/day, so it crosses the 500 cap in about five days; the others are 23 and
77 days out. There are no archives to fall back on (`rotateKeep: 0`). Raising that bound
interacts with the shared byte ceiling and changes the memory profile of every placement
read, so it needs its own spec rather than being bundled here.
<!-- tracked: ACT-1811 -->

## Evidence

Reproduced live before the fix (Mac Mini, agent echo, 2026-09-05), not inferred:

- **Before:** one placement query (`limit: 1000`, clamped to 500) returned 500 entries
  covering **33** distinct topics with an epoch floor of **6**; an exhaustive cursor walk
  of the same journal returned 1015 entries covering **150** topics. Topic 69507
  (epochs 1 and 2, rows written 18:28:50Z) was absent from the single page and present on
  page 2 — so the applier was seeing 22% of topics and never this one.
- **Observed failure chain:** the Mini's ownership view for that topic returned
  `{owner:null, epoch:0, status:null}`; the drain audit logged
  `drain-refused / not-owner / observedStatus:"none"` at 18:58:16Z and again, identically,
  at 21:44:45Z on a manual retry; the placement surface reported `pinState: "diverged"`
  from 18:58Z onward. The operator's pinned transfer never landed for ~4 hours.
- **After (test harness over a real on-disk journal, same reader code):** a fixture whose
  page 1 provably excludes the low-epoch topic (asserted in the test, both directions)
  materializes it via the paged walk — and with the paging loop reverted to a single page,
  the test fails `expected undefined to be 'm_self_mini'`, the exact production symptom.
  Falsified-then-trusted for the ceiling and zero-page guards as well.
- Full unit suite after the change: 2405 files, 43,745 tests, 0 failures.

## What to Tell Your User

If you run on more than one machine and a conversation refused to move to the machine
you pinned it to — the pin recorded, the move never happening, no error explaining
why — this is that bug. It hit newly-created conversations hardest, and it got more
likely the longer an agent had been running. After this update the move completes on
its own; there is nothing to re-do and no setting to change.

## Summary of New Capabilities

- A pinned cross-machine conversation move no longer deadlocks when the conversation
  is young — ownership is materialized for every topic in the journal, not only those
  in the highest-epoch page.
- The ownership step reports how many pages it walked, whether it hit its page
  ceiling, and whether it had to fall back to a single unpaged read.
