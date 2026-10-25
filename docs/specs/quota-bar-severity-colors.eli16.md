# Quota bars that change colour — plain-English overview

## What this is

The Subscriptions page in your dashboard lists every account your agent can run work on,
and under each one it draws two bars: how much of the 5-hour limit is used, and how much
of the weekly limit is used. Until now every one of those bars was green. An account
sitting at 4% and an account sitting at 92% drew the same green bar — just a shorter or
longer one.

That is fine when you are looking at one account. It is not fine when you are scanning a
stacked list of seven of them on a phone, which is the situation the page actually exists
for. The one thing you want to know at a glance — *which of these is about to run out* —
was the thing the page made you read numbers to find out.

This change gives the bars colour: green while there is room, amber when an account is
getting tight, red when it is at or near its limit.

## What already exists

Everything except the colour. The bars, the percentages, the reset countdowns and the
layout are all already there and are not changing. The number that decides the colour is
the same number that already decides how long the bar is — it is read from the account's
live quota, clamped to a whole number between 0 and 100, and printed next to the bar.

Your agent also already *acts* on quota: it avoids placing work on accounts that are
walled, and it can move a long-running session off an account before it hits its limit.
None of that is changing either, and none of it looks at the new colour.

## What is new

Three colour bands, decided from that same clamped number:

- **Green** — below 75% used. There is room.
- **Amber** — 75% to 89% used. Getting tight.
- **Red** — 90% used or more. At or near the wall.

That is the whole change. One small function picks one of three names, and the page has
three colour rules instead of one.

## The safeguards, in plain terms

**The colour can never say something the number doesn't.** It is worked out from the
percentage already on screen, after that percentage has been clamped into the 0–100
range. A broken or missing reading cannot produce a confidently wrong colour — it comes
out as 0%, an empty bar, which is what a missing reading already looked like. An account
with no reading at all still says "No quota reading yet" and draws no bar.

**Colour is never the only signal.** The "N% used" text sits beside every bar exactly as
it did before. If you cannot distinguish the colours — colour-blindness, a washed-out
screen, a greyscale screenshot — you lose nothing, because the number is still written
there. Nothing on the page is now readable *only* by colour.

**The colour decides nothing.** This is the part worth being clear about. The bands are
for your eyes. No part of your agent reads them. Deciding where to run work, when to move
a session off an account, and when to stop taking new jobs all keep using the raw quota
numbers and their own separate thresholds, untouched.

One consequence of that is worth knowing in advance, because it looks like a bug and is
not: the "move a session before it walls" feature has its own threshold (80% by default),
which sits *between* amber and red. So you can see an amber bar on an account your agent
has not moved anything off yet. Amber means "getting tight", not "something happened".
Those two numbers are deliberately not wired together — tying a display band to an
operational trigger would mean changing a colour silently changes behaviour.

**It is only on your screen.** No file, no message, no API response and no log line
changes. Nothing is sent anywhere, and nothing is stored.

**Backing it out is free.** There is no saved state and nothing to undo. Reverting the
change restores the old all-green bars exactly; even leaving a badly-chosen threshold in
place only mis-colours a bar whose number is still printed beside it.

## What you actually need to decide

Only one thing, and only if you disagree with it: **are 75% and 90% the right places to
change colour?**

They were chosen to match the convention already in use on another agent's dashboard, and
checked against a real account mix: accounts at 22% and 68% read green, 83% and 89% read
amber, 100% reads red. If you would rather see amber earlier (say 60%) or red later (say
95%), those are two numbers in one file and the change is a one-line edit with no
consequences anywhere else — precisely because nothing but the colour depends on them.

Everything else here needs no decision from you: it changes only how the page looks, and
it can be reverted at any time with nothing to clean up.
