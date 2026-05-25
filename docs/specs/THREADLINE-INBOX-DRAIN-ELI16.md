# Threadline Inbox / Deliberate-Drain (Phase 2b) — Plain-English Overview

## What this is

The last and biggest piece of the Threadline redesign. Today, every message
another agent sends instantly spins up a worker that always replies. This changes
that to: messages land in a per-conversation **inbox**, and a small, **capped**
crew of workers empties those inboxes deliberately.

## The everyday analogy

Right now it's like hiring a brand-new temp for every single letter that arrives
in the mail — even junk — and that temp always writes back. It works for a few
letters, but if a hundred arrive at once you've got a hundred temps trampling each
other. The fix is a normal mailroom: letters go into pigeonholes (cheap), and a
fixed small team works through them — handling a stack for one sender in one
sitting, and never more than a few people working at once. A thousand pigeonholes,
three clerks.

## Why bother, since the loops are already fixed?

Phase 1 (the reply-gate) already stopped the "thanks → thanks" loops, and Phase 2a
put everything in one tidy store. So this isn't about correctness anymore — it's
about **scale**: many agents talking to you at once. One-worker-per-message can't
scale; cheap inbox records + a capped worker crew can.

**Honest note (and I want your read on it):** if you're not expecting lots of
agent traffic soon, this big change might be more than is worth doing right now.
The spec is written to let the review + you decide whether to build the core of it
now or wait for a real "too many conversations" signal. I scoped it to the minimal
core (the inbox + the capped crew) and parked the fancier parts (a single
"new conversations" notification surface, and stranger-vetting via the
identity/reputation service) as clearly-tracked later steps.

## What stays the same

- The "does this need a reply?" gate runs first, exactly as now.
- A human in the conversation always gets an instant reply — humans never wait
  behind the worker cap.
- The single store, the anti-hijack guard, trust — all unchanged.

## Safety

The whole thing sits behind a flag, so flipping back to today's behavior is one
switch (no data to migrate). Messages are never lost: a worker only marks a letter
"done" after the reply actually goes out, so a crash just leaves it in the
pigeonhole. Full tests + the live test-on-Codey gate before it ships.

## What you're deciding

Whether to build the 2b core now (the inbox + capped worker crew), or hold it until
there's real scale pressure. Either way the two follow-on parts stay tracked.
