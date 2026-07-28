# Reconciler Pin-Store Boot-Ordering Fix — Plain-English Overview

## What was still broken

The cross-machine convergence loop (`OwnershipReconciler`) is supposed to finish a "move a
conversation between machines" hand-off. A prior fix (#1312) made it not depend on the machine's
identity being set up first. But it turned out the loop's startup check depends on TWO things, and
the SECOND one — the "pin store" (where the move instruction is recorded) — is set up about 2200
lines LATER in the server's startup than the loop is wired. So the check still failed, and the loop
was STILL never built. Live-confirmed: after deploying #1312 to both machines, the loop's status
endpoint still reported it inactive, with zero activity in the logs.

## What's new

The same proven late-binding pattern, now applied to the pin store too:
- The loop is built whenever the ownership registry exists (which is ready early) — its construction
  no longer hinges on the late-assigned pin store at all.
- The pin store is read **late**, at run-time (each tick), not captured at wire-time. While it's
  still null (early boot) a tick simply sees no pins and does nothing; once it's ready, the same loop
  instance starts converging.

## What already exists

This mirrors #1312 (the identity fix) and the sibling `OwnershipApplier`'s already-shipped fix — read
late-assigned startup values at run-time, not wire-time, so server boot order stops mattering.

## Safeguards (plain terms)

- The loop still only acts on the operator's own machines, still dark/dev-gated, still no-ops with one
  machine. Only the wiring changed — not what the loop does.
- New regression tests now lock in BOTH late dependencies (identity AND pin store): with either one
  not-yet-ready the loop does nothing; once ready, the same loop acts. So this whole "wired before its
  dependencies exist" class of bug is guarded going forward.

## What you're deciding

Whether to ship this small completion of #1312 so the convergence loop is finally built and runs. Found
by driving the feature through live — the only thing that exposes server boot-ordering bugs.
