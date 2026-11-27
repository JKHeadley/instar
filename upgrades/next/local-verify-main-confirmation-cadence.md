<!-- bump: patch -->

## What Changed

Local Verify waits at least an hour between covered main checks while main is healthy, unless its existing unverified-age limit calls for a check sooner. New main commits are grouped into the newest eligible full check. Recovery and local corroboration still run as soon as their existing rules allow.

A failed main check marks main suspect. A repeat failure in the same file on the same commit confirms main red. A different or unnamed second failure earns one more check. If that check also gives no repeat, main stays suspect and the attempt record remains available for diagnosis.

## What to Tell Your User

The Studio spends less time repeating main checks during a healthy stretch. Every change still has to pass its full verification before it can merge. A failed main check still puts merging under the existing restrictions while Local Verify checks whether the failure repeats.

## Summary of New Capabilities

Local Verify groups healthy main checks and confirms repeated file failures before declaring a new red main episode.
