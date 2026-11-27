# The test of the main line always tests the newest version

## What this is

Instar tests every change before it is merged. It also tests the main line itself from time to time, to be sure the merged result still works. Both kinds of test wait in one line for the same machine.

While the main line is healthy, waiting changes go first, and the main-line test waits up to 90 minutes for its turn.

## What went wrong

When the main-line test finally got its turn, it tested the version it had been lined up for 90 minutes earlier. By then several more changes had been merged, so that version was out of date.

A pass on an out-of-date version says nothing about the newer merges. So the moment the first test finished, a second main-line test was due, this time on a newer version. On 2026-11-16 this happened twice: about 80 minutes of main-line testing in a row each time, while eight changes waited for the machine.

## What changes

When the main-line test starts, it now looks up the newest version of the main line and tests that one. One test covers everything merged so far, and the machine goes back to the waiting changes.

Two cases stay exactly as they were. If the main line is under suspicion or known to be broken, the test repeats the version that failed, because that is the question being asked. If the newest version cannot be read at that moment, the test runs on the version it was lined up for.

## What you will notice

Nothing on screen. Changes waiting to be tested get the machine back about 40 minutes sooner in each cycle.
