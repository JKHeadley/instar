---
title: Recurrence Reader
description: Groups what the agent already notices, across all three stores, so repeated problems stop looking like a thousand separate ones.
---

# Recurrence Reader

Your agent notices things constantly, and writes them to three different places:

- the **attention queue** — things a person should see
- the **evolution action queue** — things it committed to doing
- the **sentinel log** — what the automatic watchers spotted

Nothing read across them. So the same underlying problem got written down again and again, in
different places, and every entry was individually true and individually small. Read one at a time
it looks like an enormous pile of unrelated work, and nobody can see that it's mostly a handful of
things repeating.

`RecurrenceReader` reads all three and groups entries that are really the same problem worded
slightly differently — "3 topics stranded" and "17 topics stranded" are one problem, not two.

## What it found on first run

Measured on a live agent, 2026-07-27:

| | |
|---|---|
| Open observations across the three stores | **2,068** |
| Distinct problems underneath them | **836** |
| Noticed repeatedly, **never** turned into work | **69 problems / 1,242 noticings** |

The three largest clusters had never been seen grouped: an idle-timeout check firing **278** times;
an alert suppressed **238** times because notifications were switched off — a watcher carefully
deciding not to tell anyone, and logging that decision, over and over; and one component's warnings
**177** times, nearly half the attention queue by itself.

None were new problems. They had been sitting there being noticed.

## It refuses to guess

The obvious way a tool like this becomes worse than useless is reading two of the three stores and
still reporting "nothing recurring" — the same blindness, now carrying the authority of having
looked.

It cannot do that. Every store it could not read is named in `coverage`, with the reason, and the
`verdict` field is emitted **only** on a complete read. Not hedged — **absent**, so a caller cannot
render it as an answer by accident.

- genuinely nothing there → `verdict: "no-recurrence"`
- could not look → `verdict` is **undefined**

Those are different answers and they stay different. Verified by deliberately breaking one store: it
reported the 59 clusters it could still see and drew no conclusion.

`noticingRatio` follows the same rule — it is `null`, never `0`, when there is no denominator, so a
client that ignores the contract gets an obviously-missing value rather than a plausible wrong one.

## What it does not do

**It only reports.** It does not act, queue work, or notify anyone. That is deliberate: turning its
findings into action through the paths that already exist — raising a blocker, queueing work,
advancing a phase — is a separate concern with authority this deliberately has none of. Becoming a
fourth list nobody reads would be the funniest possible way to fail at this.

**It does not judge importance.** It reports that something recurred 278 times and nobody picked it
up. Whether that is urgent or fine is a human call; grouping does not make it.

## Reading the output

Each cluster carries `count`, an `exemplar` title, the `stores` and `sources` that reported it,
first/last seen timestamps, and `tracked` — true when at least one member came from the action
queue. A high-`count` cluster with `tracked: false` is the sharpest signal available: noticed many
times, never once turned into work.

`significantClusters(report, { untrackedOnly: true })` narrows to exactly that class.
