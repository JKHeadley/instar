# Faster First Pick-Up of Shared Topic Ids — Plain-English Overview

## What this is about

Since release 1.3.1370, only the machine in charge creates the Updates, Attention and Agent Health topics in Telegram, and the other machines copy its topic ids. Each machine checks for those ids 20 seconds after it starts and then every 30 minutes.

## What went wrong

When Mama PC restarted onto that release, its first check ran before it had worked out which machine was in charge, so it found nobody to copy from and did nothing. It then waited the full 30 minutes before checking again. During that half hour it had no system topic to post to. Nothing was lost and no duplicate topic was created, but the gap was pointless.

## The change

A check that could not read the in-charge machine's record (nobody in charge yet, machine unreachable, or an empty answer) is now repeated every 2 minutes, up to 10 times, until one check actually reads the record. After that, or after the 10 tries, the 30-minute rhythm takes over as before. A check that succeeds ends the fast retries. The writes are unchanged: still the same copy-if-different logic with the same cap on how often a machine will follow a changing record.

## What to decide

Nothing. This is a timing refinement of the shipped fix; it is fully covered by tests and reverts cleanly.
