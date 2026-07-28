# A guard that took a minute to admit it couldn't run

## What this is about

Instar has a safety bound that stops too many test suites running at once on one machine. Test
runners coordinate through a small set of files in a shared folder — a rendezvous point. Whoever
holds the lock file runs; everyone else waits their turn.

Waiting is the right behaviour when someone else genuinely holds the lock, because they will finish
and release it.

## The problem

The waiting logic could not tell "someone else is using this" apart from "I am not allowed to write
here at all".

When a test run happens somewhere that cannot write to the shared folder — a sandboxed agent, a
locked-down CI box, a read-only mount — the lock attempt fails with a permission error. The code
treated that exactly like contention: it waited, retried every five seconds, and kept going for the
full budget. Sixty seconds for a small run, two minutes for a full suite. Then it gave up, printed a
clear warning, and let the run proceed anyway.

The decision to let the run proceed was always correct. The problem was that it took a minute to
reach it — because a folder you are not permitted to write to does not become writable by asking it
twelve more times.

## Why this is a correctness problem, not a speed one

Sixty seconds is longer than anyone waits before concluding something is broken.

That is not a guess. An agent running in a sandbox tried to test this very repository, saw no output
for thirty seconds, concluded the tests could not run there, and reported them as unrunnable. Four
separate sessions were written off as mysterious stalls. The warning explaining exactly what was
happening did eventually print — after everybody had stopped looking.

A warning that arrives after everyone has given up is, in practice, indistinguishable from silence.
That is the same failure this guard exists to prevent, happening inside the guard itself.

## What changed

The lock attempt now reports which kind of failure occurred. A permission-class error means the
rendezvous is structurally unusable, so the run is admitted immediately with a distinct reason
recorded, instead of being polled against a budget that cannot help.

Genuine contention is untouched: a lock held by another run still waits the full budget, because
there waiting is exactly right.

## Measured

Same test file, same unwritable folder, one tree with the fix and one without:

- Before: 66.23 seconds
- After: 794 milliseconds

The tests pass in both cases. Only the delay is gone.

## An honest limitation

When the shared folder cannot be written, the mechanism that limits how many runs may proceed at once
cannot work either — it is itself made of files in that folder. That was already true before this
change; the old path reached the same unbounded outcome, just a minute later. Saying so plainly is
better than implying a protection that is not there.
