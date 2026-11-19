# In plain words — a test-time budget for the Codex version check

## What this is about

Before Instar starts a piece of work on Codex, it asks the Codex program on that machine "which version are you?". Older versions cannot run the newest GPT-6.2 models, so Instar uses the answer to pick a model that version can run. Instar waits at most 2 seconds for the answer. If no answer comes in time, the version counts as "could not be read", and for a short one-off call Instar keeps the newer model, because that kind of call already retries on an older model if it is refused.

## What went wrong

One of this pull request's own tests uses a pretend Codex program: a tiny shell script that says "I am version 0.165.0". The test expects Instar to pick the older model for it. On a very busy test machine, starting that little script once took longer than 2 seconds. Instar treated the version as unreadable, kept the newer model, and the test failed. The product did what it is meant to do. The test was simply sensitive to how busy the machine was.

## What changes

The 2 second wait can now be multiplied by a whole number from 1 to 20, read from an environment variable. If the variable is missing or holds anything odd, the multiplier is 1. The test file sets it to 10 while it runs, so its pretend Codex gets 20 seconds, and puts the old value back when it finishes.

## What stays the same

Nobody sets that variable outside the test, so on real machines the wait is still 2 seconds. The rule for what to do with an unreadable version is untouched. Two other tests that check a stuck Codex is cut off after 2 seconds live in a different file that does not set the variable, so they still check the real limit.

## If it turns out wrong

Undo the one commit. Nothing is stored and nobody using Instar would notice either way.
