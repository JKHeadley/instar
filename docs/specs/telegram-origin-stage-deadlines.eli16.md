# A quarter of a second was not always enough — Plain-English Overview

> The one-line version: before the agent sends a Telegram message it records that it is about to, and it gave that recording a quarter of a second; on a busy machine a perfectly healthy disk write takes longer, and tests that hit this failed changes that had nothing to do with it. Tests can now allow more time. The product's own limits are unchanged.

## The problem in one breath

The agent keeps a record of every Telegram message it sends, written to disk before the message goes out, so that it can always say afterwards what it sent and why. To keep a broken disk from holding messages up for long, each step of that recording has a time limit: a quarter of a second for the main record, half a second for the fallback copy, one second for the final go-ahead.

Those limits are real waits for a disk to confirm a write. When the machine is running thousands of tests at once the disk is busy, and a write that would take a few thousandths of a second can take a second or more. Nothing is broken, but the limit passes, the message is held, and the agent reports a recording outage.

In the test suite this showed up as random failures: 29 failures or retries in a week, across nine test files, in the test runs of 17 different changes. Each failure threw away a 25-minute test run.

## What already exists

- **The recording steps and their limits**, written directly into the code as numbers.
- **A fallback chain**: main record, then a local spare copy, then another machine. Only when all fail is the message held.

## What this adds

The limits get names and can be set when the recording service is created. If nobody sets them, they are exactly what they were. The affected test files lift them out of the way. Underneath there is a second limit, the store's own two seconds per request; the test files that can also raise that one do, and the rest are left with two seconds, eight times the old quarter of a second. In those tests "slow" no longer counts as "broken".

## The safeguards

**Production is untouched.** Nothing in the product sets the new option. The default values are the old numbers, and a test pins that.

**A bad value cannot loosen anything.** Zero, negative numbers, fractions, text, nothing at all, or anything over one minute: each is ignored and the normal limit applies. Eight such cases are tested.

**Real outages still look like outages in the tests.** A recording step that fails outright still fails at once, and one that hangs is still cut off by the store's own two-second limit. Only a step that is slow but working is now waited for.

**Both sides of the limits are tested**, with a real store made deliberately slow: at the normal limit the message is held, with a generous limit it goes out. Three of the five limits are exercised this way (main record, spare copy, final go-ahead); all five share the same code.

## What it does not fix

Thirty-seven other test files use the same recording service with the normal limits. None has failed this way on record, so they are left alone; if one does, the same one-line helper applies.

The larger question is the product itself: on a real machine under heavy load, the same thing can happen to a real message. Whether the product's limits should be longer is a decision for the owner of that code, and it is written up with the evidence. This change deliberately does not make it.

## What you need to decide

Nothing for this change.
