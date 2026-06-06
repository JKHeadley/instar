# Side-Effects Review — Ownership epoch floor (live-matrix finding #7)

**Version / slug:** `ownership-epoch-floor`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Post-restart ownership epochs were reused (in-memory registry) while the
journal's (topic, epoch) op-key dedupe is restart-proof — fresh placement
evidence was silently dropped, leaving the durable record naming the wrong
machine. `cas()` now consults `epochFloorOf` (newest journaled epoch); the FSM
takes `ctx.epochFloor` (epoch = max(current, floor)); the in-memory store's
fast-forward accepts monotonic advance.

## Decision-point inventory

Two: (1) where the floor binds — at cas() entry for every action (monotonicity
insurance), sourced from the journal reader, best-effort. (2) the store
acceptance predicate — strict +1 relaxed to monotonic > for the IN-MEMORY
store only.

## 1. Over-block

Nothing. The floor only raises epochs; no action that previously succeeded can
now fail (the store accepts a superset of previously-accepted candidates).

## 2. Under-block

A stale journal (e.g. replica lag on a future shared-reader setup) could
under-floor; worst case is the pre-fix behavior for that call. The floor never
guarantees global cross-machine epoch uniqueness — it restores LOCAL
monotonicity across restarts, which is what the op-key dedupe assumes.

## 3. Level-of-abstraction fit

The FSM stays pure (floor passed via ctx); the registry owns the seam (it owns
deps); the server owns the binding (it owns the reader). The journal is not
consulted inside the FSM.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No authority added. The floor is monotonicity insurance; a reader throw reads
as 0 (@silent-fallback-ok documented at the catch) and never blocks a CAS.

## 5. Interactions

- Journal op-key dedupe: the direct beneficiary — fresh evidence journals
  under fresh keys after restarts.
- Store fast-forward: monotonic > yields the SAME loser-rejection outcomes
  for stale candidates (they propose ≤ the landed epoch — cas() is
  synchronous, no interleaving); the strict +1 FakeStore in existing tests
  keeps passing untouched.
- Epoch consumers (stillCurrent equality compare, router epoch-advanced
  inequality checks, deliverMessage staleness fencing): all tolerate gaps —
  monotonicity is the only requirement, which this change strengthens.
- The future durable Track-H store must also implement monotonic-advance
  fast-forward (noted in the casWrite interface comment's analogy).

## 6. External surfaces

None. No routes, config, or notifications.
