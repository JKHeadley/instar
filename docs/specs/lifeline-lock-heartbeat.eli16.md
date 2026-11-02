# Lifeline lock heartbeat, in plain English

## What this is

The lifeline is the always-on process that receives an agent's Telegram messages. Only one
copy may run per agent, so it holds a lock file saying "I'm running, and here is my process
id." When a new copy starts, it reads that file and normally exits.

There is one exception. A lifeline once got stuck holding the lock during a shutdown, and
every new copy kept exiting, so messages stopped until someone killed it by hand. To
prevent that, a new copy was told: if the holder has held the lock for over five minutes
and the operating system reports it as "sleeping", it must be stuck, so kill it and take
over.

## What was wrong

A healthy lifeline is sleeping almost all the time, because it is waiting for the next
message. So any accidental second start killed a perfectly healthy lifeline. Matt Abate
reported this in issue #2485, and we reproduced it on the shipped code.

He also pointed out that two copies starting at the same moment could both think they had
won. We tested that with 20 processes starting at once, and all 20 won.

## What already exists and stays the same

The check that a process really is the one that wrote the lock (by its start time, so a
reused process id is never signalled) is unchanged. So is the handling of zombie and
stopped processes.

## What is new

- **A heartbeat.** The holder updates the lock file's modified time every 30 seconds. A new
  copy treats it as stuck only if that time is over five minutes old.
- **A second look.** Before acting, the new copy waits 45 seconds to see whether the time
  moves. A Mac that just woke from sleep briefly looks stale, and this stops that being
  mistaken for a stuck process. The wait counts real polls, so a jump in the clock cannot
  shorten it.
- **One winner.** The lock is created in a single atomic step. Clearing a stale lock is only
  allowed while holding a short-lived second lock, and only if the old lock is still the one
  that was judged stale. Twenty processes racing now produce exactly one winner, in all 40
  test rounds.

## Safeguards

Every doubtful reading means "leave the holder alone". The heartbeat stops at the start of
shutdown, and the lock is released before anything that could hang, so the stuck-shutdown
incident cannot come back. A lifeline already running on older code has no heartbeat, so it
is still judged the old way until it restarts onto this version. A lock file that cannot be
read, and is over 30 seconds old, is replaced rather than blocking every later start.

## What to decide

Nothing is needed from the operator. If this turned out wrong, a revert restores the old
behaviour, and lock files written by the new code remain readable by the old code.
