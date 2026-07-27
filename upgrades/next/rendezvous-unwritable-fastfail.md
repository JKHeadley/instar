# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The host test-runner bound coordinates through lock and witness files under `~/.instar`. Its
acquisition loop could not distinguish a lock HELD by another run (transient — waiting is correct)
from a rendezvous it is not permitted to write to at all (permanent — waiting cannot help), because
`tryTakeLockOnce` collapsed every non-EEXIST failure into an undifferentiated `error`.

So in any environment that cannot write there — a sandboxed agent, a locked-down box, a read-only
mount — a permission failure was polled at 5s intervals for the entire lane budget (60s targeted,
120s suite) before reaching a fail-open admit.

`tryTakeLockOnce` now surfaces the errno, and EACCES/EPERM/EROFS are classified as a permanent
rendezvous failure that admits immediately with a distinct ledger cause `rendezvous-unwritable`.
Genuine contention is untouched and still waits the full budget.

## Evidence

Same test file, same mode-500 rendezvous, one tree with the fix and one without:

```
BEFORE   Duration 66.23s    Tests 5 passed
AFTER    Duration   794ms   Tests 5 passed
```

Falsified by disabling the fast-fail branch in production, which reproduces the old behaviour exactly
— the durations are precisely the two lane budgets:

```
× THE FIX: admits at once with cause rendezvous-unwritable, without polling      60013ms
  → EACCES: permission denied, mkdir '…/host-test-runner-witness'
× the admit still happens — the decision is unchanged, only its latency         120020ms
  Tests  2 failed | 3 passed (5)
```

Restored byte-identical. Green across every suite touching the changed files:
`Test Files 5 passed (5) · Tests 150 passed (150)`; `tsc --noEmit` exit 0.

The new tests assert on the recorded sleep list — "did it poll at all?" — rather than wall-clock
duration, so the claim is deterministic.

## Known limits

When the rendezvous cannot be written, the storm ceiling cannot bound fail-open admits: it is made of
files in that same directory. That was already true — the previous path called `claimStormSlot()`,
which threw on its first `mkdirSync`, and admitted via the outer handler regardless. This change
reaches the identical outcome in under a second instead of a minute; it does not create a protection
that was never there.

The classifier is deliberately narrow (EACCES/EPERM/EROFS). An unrecognised permanent errno still
burns the full budget, because a wrong fast-fail is worse than a slow correct one.

## What to Tell Your User

Your agent's safety limit on running too many test suites at once used to take a full minute to
notice when it could not operate at all.

The limit works by having test runs check in with each other through a shared folder. If your agent
is running somewhere it is not allowed to write to that folder, checking in fails immediately and
permanently — but the code treated that the same as someone else being mid-run, and waited its turn
for up to two minutes before giving up and continuing anyway.

Continuing was the right call. Taking a minute to get there was not, because a minute is longer than
anyone waits before assuming something is broken. That is not hypothetical: it caused several pieces
of work to be abandoned as mysterious freezes when the explanation was printed all along, just far
too late.

It now recognises a permissions problem for what it is and carries on straight away, saying clearly
that the limit is not in force in that environment rather than quietly implying it is.

## Summary of New Capabilities

No new endpoint, command, or config key. Lock failures now carry their errno, and the test-runner
bound admits immediately on a permanently unwritable rendezvous with a distinct
`rendezvous-unwritable` ledger cause.
