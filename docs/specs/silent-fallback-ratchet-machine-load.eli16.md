# ELI16 — main was failing its own safety ratchet, and every pull request was stuck behind it

## What a "ratchet" is here

instar has a rule that a `catch` block must not quietly swallow an error. A test counts
every catch that looks like it swallows, and compares the count to a number written in the
test: **494**. The number is only ever allowed to go DOWN. If a change pushes the count up,
the test fails. It is a one-way gate against the codebase slowly filling with errors nobody
ever sees.

## What went wrong

A recent change added a catch that the counter flagged, which took the main branch to **495**
— one over its own limit. So the main branch was failing its own test.

That matters more than it sounds, because of how changes get merged here. Before a pull
request can merge, it is tested as if it were already merged — the change combined with main.
If main itself is failing, then every pull request fails that test too, no matter what the
pull request contains. The queue does not stop and report the cause; each change just fails
and goes back round.

Measured, rather than assumed:

- the commit my own work branched from: **493** — fine
- main now: **495** — over the limit
- one pull request in the queue had already given up after three attempts

## What the actual problem was

Almost nothing. The flagged catch is in the code that samples how busy a machine is, and it
**already prints the error with its message**. It is not a swallow. The counter simply does
not recognise that particular way of reporting, and the codebase has a standard marker for
exactly this case — a short comment saying "this is deliberate, and here is why" — which
nobody added.

So the fix is one comment, explaining that the failure is logged, and that a missed sample is
reported honestly downstream as "unknown" rather than as a healthy reading.

## Why not just raise the limit to 495

Because the number is the whole mechanism. Raising it whenever something trips it converts a
one-way gate into a formality, and the test's own history says it only decreases. The right
move when it fires is to look at what it caught — which here took a minute and confirmed the
code was fine but undocumented.

## What you need to decide

Nothing. One comment, no behaviour change, and the merge queue starts moving again.
