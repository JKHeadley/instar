# The change that has waited longest goes next (plain version)

Written 19 November 2026. It can be read with no other background.

> The one-line version: when the test line is full, the next free place now goes to the change that has waited longest, where today newer changes with a priority label keep taking it and some changes wait a whole day.

## The problem in one breath

Every change to Instar is tested on our own computers before it can be merged. The line of changes waiting to be tested holds 10, plus 5 extra places for changes that carry a priority label. When it is full, a change is turned away and has to ask again. On 19 November, 15 changes had been turned away for between 4 and 26 hours, one of them a security fix that had asked 146 times. In the same day, 96 changes were let into the extra places, and every one of them carried the label. Not one was a change that had been waiting.

## What already exists

- **A waiting list:** a change that is turned away keeps its place in a list, with the time it was first refused.
- **A rule meant to stop exactly this:** a change that has waited 90 minutes may use the extra places too. But it only gets one if a place happens to be free at the moment it asks, and labelled changes ask more often, so they always get there first.
- **A control for the person running the line** to put a named change at the front by hand.

## What this adds

One rule at the door. When a change asks for a place, and another change has been waiting more than 90 minutes and has waited longer than it, the newcomer waits, with or without the label. The free place stays for the older one, which takes it the next time it asks (normally within about 10 minutes). If there are more free places than old waiters, the newcomer can have one of the spare ones. Among changes that have waited more than 90 minutes, it is simply first come, first served.

The label still helps: it puts a change ahead of ordinary changes that have waited less than 90 minutes, and it opens the 5 extra places. It no longer lets a change jump ahead of one that has waited longer.

A second, small thing for the person running the line: when several changes are put at the front by hand, the answer now says in which order they will run, and there is an option to add one behind the others instead of ahead of them. Today each one put at the front goes ahead of the earlier ones, and each is told it is first.

## The safeguards

**No machine waits for a kept place.** A place in the line is not a test machine: while a place is kept, the machines go on with the changes already in line, and if a machine would have nothing to do, nothing is kept and the newcomer is let in.

**A change nobody is asking about any more keeps nothing.** After 30 minutes without asking, its place is free for others.

**Putting a change at the front by hand still works**, for anything that must go now.

**It is off until the person running the line turns it on.**

## What it costs

Labelled changes wait longer while there is a backlog of old waiters. That is the point of it.

## What ships when

One small change, after review. Before it is switched on, the line records for each change let in whether an older one was passed over, so the picture above is checked first. Then seven days of counting with it on: no change let in ahead of an older waiter, as many changes merged per day as before, and how old the oldest waiting change gets (26 hours when measured).
