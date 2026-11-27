# Long-waiting pull requests get into the test queue — plain-English overview

## What happened

Local Verify is the test run every instar pull request needs before it can merge. It has a queue with room for 10 pull requests. Pull requests marked "merge-throughput" (work that speeds up merging) may squeeze in up to 5 more past that limit, so a full queue never keeps out the work that would make it faster. A pull request without the mark that finds the queue full goes on a waiting list and keeps its place there.

On 13 November that mark was on most new pull requests: ten were opened over about ten hours, and each one got in past the limit. The queue never dropped below 10, so the waiting list never moved. PR 3108 had been waiting about 18 hours, behind pull requests opened that morning.

Inside the queue there was already a rule for this: an unmarked pull request that has waited 90 minutes is treated like a marked one, so the mark can never hold an old pull request back for good. Nothing like that applied on the waiting list.

## What this change does

- A pull request that has been on the waiting list for 90 minutes may now use the same 5 extra places as a marked one.
- Once in the queue, its 90 minutes count from when it was first turned away, not from when it got in, so it is not made to wait the same 90 minutes a second time.

## Safeguards

- The extra places are still capped at 5. When they are full, a long-waiting pull request is still turned away and keeps its place.
- Nothing changes for repairs while main is failing, for re-runs, or for a pull request whose new commits replace one already queued.

## What it does not change

The waiting list's order, the queue limit of 10, and how marked pull requests are admitted all stay the same. Reverting the change brings back the old behaviour, where a steady stream of marked pull requests keeps the waiting list stuck.
