# Two agents in one room could end up sharing a conversation — Plain-English Overview

## The problem in one breath

When two agents talk in the same shared room, each is supposed to get its own private conversation thread. The name of that thread was built out of the room name and the current time in milliseconds — and nothing else. Two agents entering the same room in the same millisecond got the *same* name, and their two conversations collapsed into one.

## Why it hid for so long

It needs two things to happen inside one thousandth of a second, so it almost never fired. It failed once, at random, in an end-to-end test on 2026-08-23 — and would have gone on failing at random.

The uncomfortable part: it gets **more** likely as the code gets faster. A correctness property that erodes as you optimise is not a property.

## The part worth reading twice

There was already a test for exactly this — "different agents get different threads for same room". It passed. It passed because someone had put a two-millisecond sleep in the middle of it, with a comment explaining that the sleep was there to make the timestamps differ.

So the defect was not undiscovered. It was **observed, described in a comment, and worked around** — and the test that would have caught it was converted into a test that could not. The sleep is gone; the test now depends on the fix.

## What changes

The thread name gets real randomness in it. The timestamp stays, because it is useful to read, but nothing depends on it being unique any more.

## The safeguards

**Two tests, both sides of the line.** With the clock frozen so that every timestamp is identical: two different agents in one room must get different threads, and the *same* agent coming back must get the *same* thread. The second matters — a fix that made every message unique would have bought uniqueness by destroying continuity.

**Both were checked against the un-fixed code** and both fail there, so they are tests rather than decorations.

## What ships when

Immediately. It only affects threads created from now on; existing ones keep their names.

## What you actually need to decide

Nothing.
