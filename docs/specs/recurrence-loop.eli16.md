# Actually closing the loop — Plain-English Overview

> The one-line version: the two earlier pieces could see repeated problems and decide which deserve
> real work, but neither of them touched anything. This is the piece that joins them up and does it.

## Why this exists separately

The reader groups what we notice. The decider picks which groups deserve a work item. Both were
written as pure calculations — they take information in and hand an answer back, touching nothing.

That's good for testing, but it left an honest gap I flagged at the time: "the loop closes" was a
property of the design, not something anyone had watched happen. This is the piece that makes it
happen, and it's the only part of the feature that touches anything at all — so there is exactly one
place a read can fail, and it can't be quietly swallowed somewhere in the middle.

## What it does

Reads the three lists, groups them, decides, and creates the work items. On live data it looks at 836
problems, creates three, and holds back seventeen for later runs.

## The distinction it protects

There are two very different reasons nothing gets created, and they must never look the same:

**A refusal** — it decided not to act. It couldn't see the existing work list, so it can't tell what's
already owned, and creating anything would risk duplicating work that exists.

**A failed write** — it decided to act, tried, and the store rejected it. That's an outage.

If a broken store were reported as a refusal, a real failure would read as sound judgement. That is
precisely the disease this whole project is about — something absent presenting as something fine —
and it would be committed on the very last line of the thing built to cure it. So they're separate
fields, and a write failure is never called a refusal.

One failed write also doesn't abandon the rest; the others still go through, and the failures are
listed.

## What it still doesn't do

Nothing calls it automatically yet. Running it is currently deliberate. The work items it creates are
ordinary queue entries that a person or agent picks up, dismisses, or does — it has no opinion beyond
"this recurred a lot and nobody owned it".
