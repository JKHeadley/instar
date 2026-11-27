# A green test of the main line counts even when the main line moved before it finished (plain-English overview)

## What this is

A correction to one piece of bookkeeping in the test line (Local Verify). It stops the test line from closing merging every few hours on busy days for no real reason.

## Why it matters

The test line re-tests the main line itself from time to time. It also keeps a clock: how long ago was the oldest merge that no passing test of the main line has covered yet? If that reaches three hours, it marks the main line "suspect" and lets only repairs merge. That is a good safeguard against merging for hours on top of something nobody has tested.

The flaw was in when the clock gets moved forward. A passing test of the main line only moved it if the main line was still exactly the same when the test finished (or, since a fix two days ago, if the test had started on the newest version). A test takes about 35 minutes and often waits for a free machine first. On a busy day something merges every 20 to 30 minutes, and each merge is followed by an automatic release commit. So the main line had almost always moved, the passing test was ignored for the clock, and the clock kept pointing at a merge from hours ago.

On the morning of 2026-11-15 the main line was tested and passed three times in four and a half hours. The clock never moved. At 5:38 AM Pacific the test line declared the main line suspect, and it stayed that way; one more passing test at 6:26 cleared it for 14 seconds. Changes that had passed their own tests could not merge.

## What already exists

- The clock and the three-hour limit.
- A rule that a passing test of the current version clears the clock, and a rule that a test which started on the newest version moves it to that test's start time.

## What is new

The test line now notes, for each version of the main line, the moment it first saw a newer one. When a test of version A passes, everything up to A is covered, so the oldest uncovered merge is the one that replaced A. The clock moves to that moment. It does not matter when the test started or how many times the main line moved while it ran.

A release commit changes no code, so when A was replaced only by its own release commit, the clock moves to the moment that release commit was replaced.

## Safeguards

- The clock only ever moves forward.
- If the test line gets an out-of-date reading and sees an old version again for a moment, the first replacement time is kept, which is the stricter choice.
- If a version was never seen being replaced, nothing changes for it.
- The three-hour limit itself is untouched: a merge that no passing test covers still raises the alarm three hours after it landed.
- Going back is a normal revert.

## What it does not fix

The moment a newer version is "seen" is up to a minute after the merge really happened, because the test line looks once a minute. The clock can therefore be up to a minute generous. Against a three-hour limit that is not material.

## What a reader needs to decide

Nothing.
