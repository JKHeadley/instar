# Changing what the test line does next, without restarting it (plain version)

Written 18 November 2026. It can be read with no other background.

> The one-line version: whoever runs the test line gets two controls, "hold this change" and "do this change next", that work at once, so the line no longer has to be restarted (which throws away tests that are running) just to change the order.

## The problem in one breath

Every change to Instar waits in a queue to be tested on our two computers before it can be merged. Sometimes the person or agent running that queue needs one change tested first, because others are blocked behind it, or needs a change kept out for now. Today the only way is to edit the queue's file by hand and restart the server, and a restart cancels the tests that are running on both machines. On 18 November the server was restarted 24 times, about 9 of them only to change the order, and 9 test runs were cancelled part-way.

## What already exists

- **The queue.** It tests changes roughly in the order they arrived, with a few fixed rules (a check of the shared code itself comes first when it is due; changes with a special label go ahead of others). It has a size limit; changes that do not fit wait on a list.
- **A way to stop a change from merging** (a marker on the change). It does not stop the change from being tested.

## What this adds

**Hold.** A held change is taken out of the queue and is not tested until it is released. Its place goes to the next change waiting. When released it comes back with the waiting time it had earned. If it is already being tested, that test is left alone. One request can hold a change from being tested and from being merged at the same time.

**Front.** The named change is tested next. It works even when the queue is full and the change is not in it yet, which is exactly the case that forced restarts on 18 November. If a test of that change is interrupted, it is still first when it comes back.

## The safeguards

**The regular check of the shared code cannot be starved.** When that check is due, at most one "do this next" change goes ahead of it.

**A hold cannot be forgotten silently.** Held changes are listed where the queue is shown, and one reminder is raised if a hold outlasts its expected date, or a day.

**Neither control cancels a running test.** That is the cost this change exists to avoid.

**They are switched off until the operator of a line turns them on.**

## What it is worth

About 1 more merged change a day by my estimate, from tests no longer thrown away, which is small. The larger gain is time: a fix that many other changes are waiting on gets to the front in seconds. After a week of use I report the number of restarts and cancelled tests against the three days measured here.

## What ships when

One change, after review and the Chief of Staff's approval. The other half of the restarts, the ones made to install a new version, are the next thing to fix: a restart that waits until both machines are between tests.
