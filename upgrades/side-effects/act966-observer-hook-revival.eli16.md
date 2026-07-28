# Reviving the observer that has never once observed — Plain-English Overview

> The one-line version: a watcher that was supposed to notice when I claim something is "done" has been completely dead since the day it shipped, and it failed in the one way nobody notices — quietly.

## The problem in one breath

There's a small watcher that runs after each of my replies. Its job is to notice when I claim I've finished or fixed something, and to record that claim so it can later be checked against what I actually did. It has **never recorded a single thing**.

Not "recorded a few and stopped". Never. Not once. And because the watcher is designed to be silent when there's nothing to report, a watcher that's totally broken looks exactly like a watcher that's working fine on a quiet day.

## What already exists

- **The watcher** — runs after each reply, reads a bounded slice of the conversation locally, and sends a small summary of the *shape* of the reply (never the text, never commands, never file paths).
- **The analysis behind it** — the part that would compare "I said I fixed it" against evidence. It works; it has simply never had any input from the watcher.
- **The update mechanism** — this watcher is regenerated from scratch on every agent update, so fixing the template fixes it everywhere automatically.

## What this adds

Two separate faults, each fatal on its own:

**Fault one: it crashed while addressing the envelope.** The watcher builds an ID for each observation. That ID-builder reached for a tool that wasn't available where it was standing — a scoping mistake, where the name it used pointed at a similar-but-different object with no such function. The killer detail: the ID is generated *inside the act of composing the message it was about to send*. So it crashed mid-compose, and the message was never sent at all. Then its safety net caught the error and exited quietly, reporting success.

**Fault two: it was looking in the wrong filing cabinet.** The watcher only reads conversation files from one specific folder, for safety. But this agent stores its conversations in a *differently named* folder — a supported setup that the watcher didn't know about. So even with fault one fixed, every single conversation would have been turned away at the door, silently.

That second one matters more than it sounds: **fixing only the reported bug would have produced a fix that changed nothing**, while the ticket got closed as done. That's the exact trap this family of bugs keeps setting.

## The safeguards

**The fix was tested by watching, not by hoping.** I pointed the watcher at a mailbox I controlled instead of the real one, so nothing else could muddy the result. The old version delivered **nothing**. The new version delivered exactly one message. That's the difference between "the code looks right" and "the thing arrives".

**Why a controlled mailbox at all:** my first attempt counted records in the real system before and after. The count moved on its own between checks — other activity was writing at the same time — so the numbers couldn't prove anything either way. Rather than read a comforting number and call it proof, I isolated the test.

**The scoping trap can't come back through a side door.** The ID-builder now uses a tool that's always available and behaves identically regardless of how the file is loaded. An earlier incident in this codebase involved exactly this kind of load-style mismatch breaking a different hook, so the fix avoids reintroducing that dependency at all.

**The tests run the real thing.** Rather than checking whether the code *mentions* the right function, the test pulls the actual generated ID-builder out of the actual generated watcher and *runs* it — in both loading styles. Pointed at the old version, it fails with the exact original error.

## What ships when

All together: both fixes plus the tests that keep them fixed.

## What this unblocks

A previously approved improvement was stuck waiting on real measurements from this watcher — measurements that couldn't exist while it was dead. Those can now start accumulating.

## One thing I did not fix

The watcher sends its message and exits immediately without waiting for delivery confirmation. If it exits fast enough, an occasional observation can be lost. That's how it was already built, it's unrelated to these two faults, and changing when a watcher is allowed to exit is its own decision with its own risks. I've written it down rather than quietly bundling it in.

## If it goes wrong

Undo it; agents pick up the reversal on their next update. Nothing stored, nothing migrated. Worst case is a return to a silent watcher that does nothing — which is exactly today.
