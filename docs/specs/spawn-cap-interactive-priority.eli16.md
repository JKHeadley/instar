# Interactive Priority Lane — Plain-English Overview

## What this is about

To keep from crashing the whole computer, I have a hard limit on how many AI
"thinking" jobs I run at the same exact moment (the default is eight). It's a
safety cap — it exists because once, two of my processes spawned hundreds of jobs
at once and ate all the machine's memory until it fell over. So now there's a
firm ceiling: only so many jobs run concurrently, and the rest wait their turn.

## What broke

The problem is the cap treats every job as equal. When the machine got busy on
the bad night, **your reply** — the message you were sitting there waiting for —
had to wait in the exact same line as a bunch of my background self-checks and
housekeeping chatter. There were no slots left, your reply's short patience timer
ran out, and the safety system decided to hold the message rather than send
something unchecked. So the cap that protects the machine from crashing became
the reason you got silence. That's backwards: the thing you're waiting for should
never lose its place to my own background noise.

## What this change does

It splits the eight slots into a few lanes instead of one undifferentiated line:

- A couple of slots are **always kept open for the back-and-forth with you** —
  both your reply going out AND your message coming in (including an "stop
  everything" you send in a hurry). They can't be filled up by background work.
- A couple of slots are **always kept open for background safety checks** — so
  giving your messages priority can't completely starve the watchdogs either.
- The rest are shared, first-come-first-served, like today.

So under load, there's always a reserved slot ready for the message you're
waiting on instead of it sitting behind a hundred background jobs. And — this is
the important part — the total cap of eight never changes. I'm only deciding
*who gets which of the eight*, never raising the ceiling. The crash-protection is
exactly as strong as before. I also can't quietly tag my own background chatter
as "high priority" to cheat — the code only honors that tag from the two specific
places that handle your actual messages, and a check in the build fails if anyone
ever tries to add a third.

## What it does NOT do

It does not kill any work that's already running to make room — it just reserves
a few slots ahead of time. That's the simple, safe version. It also only marks
*your actual replies* as high-priority — not my background reviewers, not my
sentinels, not scheduled jobs. Those stay normal. I was careful about this
because one of my background reviewers (the one that runs ten copies at once) was
literally the thing that caused the original crash, so I made sure "high
priority" can't accidentally apply to it.

## How you turn it on or off

It ships off-for-everyone-else and on-only-for-me first, so I can watch it work
for a while before it goes wider. It's a single switch — if it ever misbehaves,
flipping the switch puts everything back exactly the way it is today, with no
cleanup and no leftover state. You'll be able to see, at a glance, how many slots
each lane is using, so "is my reply being starved right now?" is something I can
just read off, not guess at.

## Why it matters

This is one of the seven fixes from the "your experience is the product"
standard. The whole lesson from that outage was that all my safety machinery
pointed inward — at keeping *me* correct — and none of it protected *you* being
able to reach me and hear back. This fix is specifically about responsiveness
under load: when the machine is busy, the human waiting for an answer comes
first.
