# Making the decision log refuse a decision that does not say why — Plain-English Overview

> The one-line version: I wrote down four decisions, believed I had recorded the reasoning behind
> each one, and had not. The system accepted every word and stored it where nothing would ever read
> it. Nothing told me. It could not have told me.

## What happened

My operator asked for something specific: stop escalating every choice to him, decide against our
stated goals instead, and log the reasoning so he can review it later. He was explicit that this
should be enforced by infrastructure rather than by me remembering.

So I went to find out what would need building — and nearly told him we needed to build a decision
recorder. That was wrong. One already exists. Its own description says it exists so that agents can
log decisions when they face tradeoffs, and reflect later on whether those decisions matched what
we said we cared about. It has a write endpoint, a read endpoint, statistics, and a separate
component that reads it back to detect drift.

It had recorded zero decisions. Ever.

So I logged four, then a fifth. Then I looked at what I had actually stored.

## The part I got wrong without being told

Each time, I sent a field I called `reasoning`, and once a field I called `checkedAgainst`. Neither
is a real field. The system has a real one for exactly this — it means "which principle or intent
guided this choice" — and I never filled it, because nothing asked me to and nothing objected.

My made-up fields were saved. They are sitting in the file right now. Nothing reads them. No
statistic counts them, no drift detector consults them, no review surface shows them. I had written
to a drawer nobody opens, and the system returned success.

That is worse than losing the data outright, because I told my operator the reasoning was recorded.
I believed it. The only reason I found out is that I went to read my own file.

## The second half, which is the same bug wearing a different hat

The statistics surface reports which principles have been referenced most. With five entries and
nobody having filled that field, it reported an empty list.

An empty journal also reports an empty list.

So "nobody has made a decision yet" and "five decisions were recorded and not one of them said why"
produced identical output. The instrument built to detect unreasoned decisions could not distinguish
its own worst case from a clean slate.

## What this builds

Two refusals and one counter.

**The log now rejects a decision that names no guiding principle.** Not a warning. It refuses to
record it, and the rejection says why in words, naming the missing field.

**It rejects invented field names too**, listing them back and pointing at where the content actually
belongs. This is the one that would have caught me. Had it existed an hour ago, my very first attempt
would have failed loudly instead of succeeding quietly, and I would have fixed it in seconds instead
of discovering it by accident.

**And the statistics now carry two counts side by side** — how many entries named a principle, and
how many did not. Those two numbers are the entire difference between an empty journal and a journal
full of unreasoned decisions.

## What it does not do

**It does not make me consult our goals.** It makes me unable to *claim* I did without saying which
one. That is a real difference and I want to be honest about which side of it this lands on. The
thing that fires at the moment of a decision and puts the goal hierarchy in front of me is a separate
piece of work and is not in here.

**It does not touch the automatic path.** Decisions the system generates on its own — routine,
machine-applied ones — have no principle to cite and are deliberately left alone. Blocking those
would break automatic dispatch to buy nothing. Only the path an agent writes to by hand is gated.

**It does not repair the five entries already written.** They keep their unread fields. The counters
will show them for what they are, which seems better than quietly rewriting my own history.

## The part worth more than the feature

I have a rule that nothing counts as done until I have broken it deliberately and watched the tests
complain. I broke the checking logic four different ways and it complained properly each time.

Then I broke the *connection* between the checking logic and the thing that receives submissions —
so that nothing was ever actually checked. **All eleven tests still passed.**

That is the second time tonight. The exact same shape, one feature apart: the logic thoroughly
guarded, the wiring between the pieces not guarded at all, and a full green test run agreeing that a
surface which checks nothing is fine. Last time I found it by luck. This time I went looking for it
on purpose, because it had just happened, and it was there.

The tests that catch it are in a separate file whose only job is to prove the receiving end actually
asks. Break that wiring now and four of them fail immediately.
