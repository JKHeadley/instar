# A broken main line is re-tested within minutes, and doomed test runs stop (plain-English overview)

## What this is

Two small changes to the test line (Local Verify). Both come from one evening, 2026-11-14 Pacific, when a merge broke one of the project's quick checks on the main line and no change could merge for two and a half hours.

## Why it matters

When the main line is broken, the test line closes merging to everything except a repair. That is right. But two things made the evening much longer than it needed to be.

First, after the repair merged, merging stayed closed for another 111 minutes. The test line reopens merging only after it has tested the main line itself and seen it pass. That test waits for the main line to sit unchanged for a while, a rule meant to avoid re-testing after every single merge on a normal day. On a day when the main line is broken, that wait only keeps merging closed.

Second, while the main line was broken, 21 other changes each took a turn on a test machine and failed the same check in about 90 seconds. None of them could have passed. The test line already knows how to prevent this: when the main line fails a test file, it lets only changes that touch or mention that file take a turn. It did not do this here because what failed was one of the quick checks that run before the tests, and the rule only looked at test files.

## What already exists

- A record of whether the main line is healthy, suspect or broken.
- A waiting period before the main line is re-tested after it changes.
- A hold that, when the main line fails a test file, lets repairs run first and keeps other changes in their place in line.

## What is new

1. While the main line is suspect or broken, a new version of it is tested once it has looked the same for two minutes, instead of ten (and after ten minutes at most, instead of thirty). On a healthy day nothing changes. The wait is two minutes and not zero because the test line checks the main line once a minute and occasionally gets an out-of-date answer; two matching answers in a row keep it from re-testing the broken version by mistake.
2. When the main line fails one of the quick checks, the hold treats that check's script the way it treats a failing test file: a change that touches the script or mentions its name runs, the others wait in place.

## Safeguards

- Each version of the main line is still tested at most once by this rule, so a version that already failed is not tested in a loop.
- The hold decides only who takes the next turn on a test machine. It never decides what may merge; a repair still has to pass its full test.
- If the failed quick check cannot be identified from the record (for example the type check), the hold does nothing, exactly as today.
- The existing switch that turns the hold off still does.
- Going back is a normal revert.

## What it does not fix

It does not stop the bad merge itself. A change tested on a slightly older main line can still merge after a new check has arrived. That needs a quick re-check right before merging, which changes what may merge and so goes through a full design review of its own.

## What a reader needs to decide

Nothing.
