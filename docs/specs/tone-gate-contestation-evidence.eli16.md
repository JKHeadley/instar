# ELI16 — Finding out which of the gate's decisions we actually disagreed with

## What exists today

Every message the agent writes to you passes a checker first. It looks for things
that shouldn't go out — a raw file path, a command, a config key — and for
behavioural traps, like quietly handing you a job the agent could do itself. It
either lets the message through or stops it.

Separately, a system records each of those judgments so we can ask: *is this checker
any good?* Over one week it recorded 1,087 real decisions.

All 1,087 came back **unknown**. Not one scored either way.

## Why the number was zero

The recording side worked perfectly. The scoring side was never built.

There's a piece that says "this decision's window closed and nothing arrived, so
stop waiting." That exists and does its job — but it's a *timer*, not a *judge*. The
thing that actually decides how a call turned out was never written for this checker.
Two other, much rarer checkers do have judges; neither fired all week.

Underneath that was a missing wire. Each decision gets a tracking number when it's
made, but nothing carried that number forward to whatever happened next. Even with a
judge, there'd have been nothing to attach a verdict to.

## The idea

The evidence is already happening — nobody was writing it down.

When the checker stops a message, the agent sometimes disagrees and re-sends it
unchanged with an explicit acknowledgment. That already exists and is already
permitted. It's a recorded moment of disagreement with a specific decision, and it's
the one thing we can capture cleanly today.

So: when the checker stops a message, it now hands back a small ticket. If the agent
overrides, it hands the ticket back. The ticket says exactly which decision this
override answers.

## Why the ticket is signed

Without a signature, anyone could take a ticket, point it at some *other* decision,
and mark that one as disputed. The ticket is therefore sealed — the system only
accepts tickets it issued itself, only for the rule they were issued for, and only
for about half an hour. Forged, edited, expired, or reused tickets are all refused.

Refused in the safe direction, which matters: a bad ticket never blocks your message.
It just means nothing gets recorded about that decision. Nothing you send ever
depends on this working.

## The first design was worse, and an outside reviewer had to say so three times

The original approach didn't use a ticket. It took a fingerprint of the message text
and looked it up later to figure out which decision an override answered.

That dragged in a lot: a secret key, plus where to store it, what to do if it got
damaged, whether to rotate it. A storage file with an expiry policy. A rule for
guessing which decision you meant when the same text had been stopped twice. And it
broke across machines, because the fingerprint had to be reconstructed from whatever
that particular machine happened to remember.

A reviewer from a different AI family kept pointing out there was a simpler way. For
two rounds the response was to write better explanations for keeping the complicated
version. On the third round it named the pattern directly: carefully documenting a
known weakness can *feel* like rigour while being the opposite of fixing it. The
complicated version was deleted.

## The most important decision in the whole design

Most of the time a message just passes and nobody says anything.

It's tempting to count that as a point for the checker. Do it, and the headline
number becomes roughly 99% accurate. It would look fantastic.

It would also be meaningless — a checker that blindly approved *everything* would
score exactly the same. Silence tells you nothing about whether a judgment was good;
it tells you nobody happened to object.

So silence stays unknown, permanently and on purpose. A test fails loudly if anyone
later "improves" this by making silence count.

## Two things this deliberately can't tell you

**It can't say the checker was right.** Scoring a stop as correct would need to know
that the agent accepted the objection and rewrote — and there's no way to confirm the
replacement came from the same session. Two of your machines can serve one
conversation at once, so another session's ordinary message could be mistaken for the
rewrite and score a win from nothing. That's on the list, with the missing piece named.

**An override isn't proof the checker was wrong.** It proves the sender chose to
override. That might be urgency, or a rule being correct but inconvenient. So it's
filed as what it is — the sender's own account of their own judgment — and any real
independent evidence outranks it.

The result is narrow: a count of decisions that were contested, paired with a count
of the ones we couldn't attribute. It won't tell you whether one model checks
messages better than another. It will tell you, for the first time, which specific
calls the agent actually disagreed with — and it's honest about what it's missing.
