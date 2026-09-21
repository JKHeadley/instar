# Trying Jev under our message gate, without letting it touch anything — plain English

## The background

Before any message I send goes out, a two-layer check runs. The bottom layer is a
set of hand-written pattern matchers that spot things like file paths, terminal
commands and configuration keys. The top layer is a language model that decides, in
context, whether showing that thing to you is actually a problem.

Yesterday's research found that Jev — the fast decision model we tested all day —
matches those bottom-layer patterns exactly on real traffic, and is much harder to
fool: tricks like added spaces or invisible characters walk straight past a
pattern, and did not get past Jev once.

## What this plan builds

A shadow. When switched on, every message that goes through the gate also gets
shown to Jev, and we write down whether Jev and our patterns agreed — and nothing
else happens. Jev's opinion changes no decision, blocks nothing, delays nothing.
It is wired in a way that cannot slow the gate down even if Jev hangs, because the
gate never waits for it.

After a two-week trial we read the record: how often did they agree, and who was
right when they differed? Only then, as a separate decision, would anyone propose
actually using Jev in the gate.

## The one thing that needs your say-so

Switching the shadow on means the text of outgoing messages is also sent to
TypeSafe, the company behind Jev — a very young vendor. Our messages already go to
the big model providers on every gate check, so this is one more recipient, not a
new kind of exposure. But it is your call, not mine: the switch ships OFF, and it
stays off until you explicitly approve the trial. You can also approve a partial
trial where only one message in ten is shadowed.

## What it costs and what could go wrong

Jev pricing makes the trial cost pennies. If Jev is down or slow, the shadow
quietly writes "could not check" for that message and the gate carries on exactly
as today. If you never approve the trial, the code sits dark and does nothing —
which is fine, because it is a measuring instrument, not a feature.

## What we would learn

Whether the most fragile part of our message safety — the hand-written patterns
that silently went stale this week (that is how the credential gap happened) —
can be backed by something that reads meaning instead of characters, measured on
our real traffic instead of my test benches.
