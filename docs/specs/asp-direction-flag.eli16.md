# The provenance recorder should only look at incoming messages — Plain-English Overview

> The one-line version: the part that records "who wrote this message" was also
> inspecting the agent's own outgoing messages, which is not what it is for.

## The problem in one breath

Instar can now tell an operator's own words from an agent's, by checking a
signature on incoming messages. The piece that does the checking hooks into a
shared point that every message passes through — **in both directions**. That
shared point hands over a flag saying which way a message was travelling.

The checker accepted that flag and then never looked at it. So it also inspected
the agent's own outgoing messages and wrote them into the record.

## Why that matters

The record exists to answer exactly one question: *did this arrive from the
operator, or was it written by an agent?* Filling it with rows about the agent's
own outgoing traffic clutters the only evidence there is for that question.

It was never dangerous — nothing was mislabelled in a direction that could
mislead anyone about an operator's words, and no message was ever blocked,
delayed, or changed. It was noise in an audit trail, in a feature whose entire
value is that its audit trail is trustworthy.

## How it was found

Not by a test. By reading the live system after the feature was deployed and
noticing a recorded row whose size matched a message the agent had just sent
itself.

## What changes

The checker now ignores messages explicitly marked as outgoing, and counts how
many it skipped so the behaviour is visible rather than invisible.

## The safeguards

**Only an explicit "outgoing" mark is skipped.** If a caller never says which
direction a message travelled, it is still checked. A missing flag must not
quietly switch provenance off — the failure leans toward recording too much
rather than too little.

**The tests prove both directions.** One test sends the same bytes marked
outgoing and expects nothing recorded; a partner test sends them marked incoming
and expects a full record. Without that second test, the first would pass equally
well against a checker that had simply stopped working.

**Verified it can fail.** With the fix switched off, exactly those two tests fail
and the other thirteen still pass — so they measure this change and not something
else.

## What ships when

All at once. It is a few lines plus tests, with no configuration and nothing for
anyone to turn on.
