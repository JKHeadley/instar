# Multi-Machine Coherence — the plain-English version

## The problem, in one picture

Imagine you have one brain but two bodies. We've already taught the bodies not
to talk over each other — only one answers the phone at a time, and when a
conversation moves from one body to the other, the old one stops mid-sentence
instead of double-answering. That part works.

What does NOT work: the two bodies don't share memories. Body A spends all
night working on something, writes its notes in its own notebook — and Body B,
picking up the same conversation the next morning, has never seen the
notebook. That literally happened: the Mini did a night of analysis and the
Laptop couldn't see any of it. Nothing crashed. The agent still lost its own
work.

## The fix, in four pieces

**1. The inventory (this round).** First, list every notebook the agent keeps —
all of them, about 100 — and stamp each one: "both bodies must see this,"
"this one is genuinely private to one body" (like its own pulse rate), or
"this is scratch paper that can be recomputed." Today nobody even has the
list, which is why things end up private by accident. We also add a tripwire:
any NEW notebook a future feature creates must declare its stamp, or the build
fails.

**2. The diary.** Each machine keeps a cheap append-only diary of events that
matter for coordination: "topic 13481 moved to the Laptop at 9:20pm, because
the user asked," "the Mini started an overnight job for topic 19437 and wrote
its results to these files," "this threadline conversation lives on the Mini."
Machines swap diaries constantly (it's tiny — just one line at a time). Now
any machine can answer "where did that happen, and where are the files?"
instead of guessing.

**3. The reflex.** When a machine notices it's missing something — the user
mentions work it can't find — it checks the diaries, sees which machine has
it, and asks that machine for exactly the missing piece. Also runs quietly in
the background: "I have your diary up to line 4,000; send me what's new."

**4. The two channels.** Big durable things travel through git (slow lane,
versioned). Small hot things — diary lines, "what's new" checks — travel over
the machines' existing secure direct line (fast lane). Secrets keep their own
armored channel. Every notebook's stamp from step 1 decides its lane —
no more case-by-case improvising.

## Why we trust this plan

The day this kicked off, the laptop was so overloaded that delivering this
very plan to you failed in three different ways (a reply got lost after the
server said "sent!", the server restart-looped, your message arrived three
times). Every one of those failure modes is now a written requirement: never
say "done" before it's saved, survive restarts, assume every message arrives
twice, stay readable even when the server is choking.

## What happens next

This round ships only paper: the inventory and this plan, for your review.
The first real build (next round, on your word) is the diary plus the "topic
moved" history — small, immediately useful, and everything else stacks on it.
