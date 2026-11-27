# Every test gets the longer allowance for Telegram message recording

## What this is about

Before the agent sends a Telegram message it writes down who is sending it and why. That record goes to disk, and the code gives each step of the writing a short time limit: a quarter of a second for the first attempt, half a second for the backup, about a second for the rest. If a step runs out of time, the message is held instead of sent. In real use that is the right behaviour: better to hold a message than to send one with no record.

## What was wrong

Tests use the real recording code and a real disk. When the full set of tests runs, the disk is very busy, and a perfectly healthy write can take longer than a quarter of a second. The message is then "held", and a test that was checking something else entirely fails.

This has failed changes that had nothing to do with Telegram 29 times across 17 different changes in one week. Each failure costs a 20 to 40 minute test run.

Two earlier changes went after it one test file at a time: first the two worst files, then eleven more. The same morning those were ready, two files nobody had touched failed in the same way. 46 test files use it, and any of them can trip.

## What changes

The time limits now live in one small file, and that file has a single switch: "for this whole program, use these limits unless told otherwise". The setup file that every test loads before it starts flips that switch to 20 seconds per step.

So every test, in every file, gets the long allowance without anyone having to remember to ask for it.

## What stays the same

- The real agent never flips the switch. Its limits are exactly what they were. A test checks this by reading the source code and failing if anything outside the tests uses the switch.
- A test that wants the short limits can still set them for itself; its own setting always wins. The tests about the limits themselves do exactly that.
- A recorder that is actually broken (it reports an error, or it has been shut down) still fails at once. The longer allowance only changes how long a slow but working disk is waited for.
- A stuck recorder is still caught: the storage layer below has its own 2-second limit per request, which this does not touch.

## What could go wrong, and why it is acceptable

A test that depended on a step timing out by itself after a fraction of a second, without setting the limit, would now wait 20 seconds. The tests that check for a held message were read one by one, and each makes the recorder fail outright or shuts it down; none waits for a slow one. An independent reviewer was asked to look for any that were missed.

## What you need to decide

Nothing. This is a change to how tests run, made so that unrelated changes stop failing on a busy disk.
