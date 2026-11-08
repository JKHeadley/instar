# Local Verify waiting list — plain-English overview (fb-7fde7f49-8ee)

## What this is

Local Verify runs the full test suite for a pull request on our own machine before it may merge. It has a queue with room for ten pull requests. When the queue is full, a new pull request is turned away with "queue full". Until now that was all that happened: the refused pull request had no place in line. The merge watcher offers every eligible pull request again every ten minutes, and agents can also ask directly, so when a slot opened it went to whoever asked first after that moment, not to whoever had been waiting longest. On the Studio over one day, 34 pull requests were turned away 1,238 times; most got in after about an hour and a quarter, the worst after ten hours, and four were still outside after about fourteen hours. One pull request was turned away 87 times.

## What already exists

The queue already keeps a pull request's place once it is inside: a new push to the same pull request takes the old entry's slot ("kept place"). Pull requests labelled `merge-throughput` already get five extra slots past the cap. While `main` is red, a pull request that fixes the failing check is already let in past the cap. None of these change.

## What is new

A small saved list, kept on disk next to the queue, of pull requests that were turned away, ordered by when each was first turned away. When the queue has free room, the pull requests at the front of that list get it. A newer pull request that asks first is turned away again and told it is waiting. When a pull request from the list gets in, its first refusal time travels with it into the queue and into the log, so we can finally measure how long it waited outside.

## The safeguards

The worry with any reservation is a slot held empty for someone who never comes. Four rules stop that. A waiter only holds its place while it keeps being offered: if it is not offered for thirty minutes (three of the merge watcher's ten-minute passes), it holds nothing, and after six hours idle it is removed. A pull request that closes, merges, already has a result, or stops being trusted leaves the list at once, and a sweep checks a few waiters every five minutes for closed or merged ones. The list holds nothing while `main` is unhealthy, because nothing is offered then (and its clock stops so waiters do not lose their place to the outage). And it never holds a slot when the queue is empty, so the test machine never sits idle because of it. If the saved file is damaged, it is moved aside and the list simply starts empty, which is the old behaviour.

## Choices made

There is no on/off switch. The paths that had to stay exactly the same (fix-while-red admission, the extra room for `merge-throughput`, kept-place re-queues) are not touched by the new code at all, and the change to ordinary admission is the point of the work. Undoing it is a plain revert; the leftover file is then ignored.

One related fix: a failed pull request gets one automatic re-run when `main` has moved on. That re-run used to be used up even when the request was then turned away for a full queue. It is now used only when the pull request actually gets in. And the automatic re-run of failed pull requests that happens once when `main` turns green again is not held back by the waiting list, because nothing would ever offer it a second time.

## What the reader needs to decide

Nothing beyond reviewing the pull request. The numbers to watch after it ships are the `firstRefusedAt` to `queued` gap in the Local Verify log, and the `queue-full-waiting` rows.
