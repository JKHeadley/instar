# The dashboard said "50% failing" and "healthy" at the same time — Plain-English Overview

> The one-line version: a panel meant to tell you whether the routing layer is healthy would say it
> was healthy when nothing had run at all — and, in one case, said "healthy" while displaying a fifty
> percent failure rate two lines above.

## The problem in one breath

There is a dashboard panel summarising how the internal checks are doing. It shows an error rate and a
sentence of plain-English verdict. If nothing had run in the last day, the panel showed "Error rate:
0%" and wrote "Routing is healthy — 0 checks ran with no check failing." A sentence that tells you
nothing ran and calls that healthy in the same breath.

## What already exists

- **A ledger of every internal check call** — how many ran, how many failed. That part is accurate.
- **A per-check alarm** that flags any single check failing too often. This part was already careful:
  it refuses to judge a check with fewer than five calls, because a rate over one or two calls means
  nothing.
- **A minimum-call threshold, written at the top of that very file**, with a comment explaining it
  exists because an error rate below that volume is not statistically meaningful.

## What this adds

The panel now uses the threshold its own file already declares. With no calls at all, the error rate
reads "no calls yet" rather than a zero you cannot distinguish from a measured one, and the verdict
says there is nothing to judge yet. With a handful of calls it shows the real rate but declines to
call anything healthy, saying plainly that the volume is too low to tell.

**And the ordering now guarantees that a real failure is reported first, always.** Not enough evidence
is a reason to withhold reassurance. It is never a reason to withhold a warning.

## The worst case, which is what makes this more than tidiness

Because the per-check alarm sensibly ignores checks with fewer than five calls, but the verdict
sentence had no such condition, a window with two calls where one failed produced this:

    Error rate: 50%
    "Routing is healthy — 1 checks ran with no check failing a meaningful share of its calls."

A fifty percent failure rate displayed directly above the word healthy. **The two halves of one panel
contradicted each other**, and each half was individually defensible — the alarm was right to stay
quiet on two calls, and the verdict was simply never told about the threshold the alarm was using.

## The safeguards

Nothing here can block, delay or change anything: it is a read-only panel. The genuinely-healthy case
is untouched — ten clean calls still reads "Routing is healthy", word for word as before. And the
failure case is untouched too: six calls with three errors still surfaces the failing check.

A small grammar fix falls out of the same work: "1 checks are failing" now reads "1 check is failing".

## A note on my own test

My first test for this failed against correct output. It checked that the words "routing is healthy"
were absent — but the new caveat legitimately contains them, in "too few to say whether routing is
healthy". The test was wrong, not the code.

Worth writing down because this project is about instruments that mis-measure, and a test is an
instrument. I caught it by running it. Had I written it and trusted it, I would have "fixed" working
code to satisfy a bad assertion.
