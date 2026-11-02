# A second lifeline start no longer kills a healthy one

<!-- bump: patch -->

## What Changed

Fixes #2485, reported by Matt Abate. When a second lifeline started more than five minutes
after the first, it read the holder's `ps` state `S` as wedged and killed it, but a healthy
idle lifeline is in `S` nearly all the time. New locks carry `heartbeatMs`, and the holder
touches the lock's mtime every 30 s. Such a holder counts as wedged only when the mtime is
over five minutes old and stays still through a 45 s second look. A lifeline still on older
code keeps the old test until it restarts onto this version.

Creating the lock is now atomic, and clearing a stale lock needs a short takeover mutex and
an unchanged lock, so only one starter can win.

## What to Tell Your User

A stray second start of my Telegram process could restart a healthy one, which could briefly
interrupt messages. It now exits and leaves the running one alone. A process that is really
stuck is still replaced automatically.

## Summary of New Capabilities

- None: this is a reliability fix.

## Evidence

Reproduced on v1.3.1576: an idle Node process with a 6-minute-old lock was killed, and one
with a 1-minute-old lock was left alone. After the fix, the idle holder survives and a holder
with a stopped heartbeat is replaced (unit tests with real child processes).

Race of 20 real processes starting at once: on the shipped code all 20 won, with no lock and
with a dead holder. The first version of this fix let 2 win in 2 of 5 dead-holder rounds,
which led to the mutex. The final code gave exactly 1 winner in all 40 rounds.
