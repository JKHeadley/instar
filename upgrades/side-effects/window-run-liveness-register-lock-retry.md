# Side-Effects Review — window-run-liveness register: retry lock contention at the route

**Version / slug:** `window-run-liveness-register-lock-retry`
**Date:** `2026-09-27`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1: route-local, one error code, bounded)`

## Summary of the change

`POST /window-run-liveness/register` now retries `authority.register()` ONLY when it throws
`ELOCKED` (the proper-lockfile "Lock file is already being held"), awaiting 20 ms between
attempts, up to 100 retries (~2 s — the same budget `withMutationAsync` already uses). Every
other error is still a 409 on the first attempt, unchanged. The authority's API and all its
callers/tests are untouched.

Why: `register()` takes the mutation lock with `lockSync` (no retries) while the background
`tick()` holds the same lock across awaits via `withMutationAsync`. A register arriving
mid-tick answered 409. Reproduced deterministically under machine load in
`tests/e2e/window-lifecycle-expiry-freeze-production.test.ts`, identically on a clean
`origin/main` (byte-identical module, server, routes and test), so it predates the branch
it ships on. A synchronous retry loop would deadlock (the async holder needs the event loop
to release); awaiting between attempts yields it.

## Decision-point inventory

- Register lock-contention handling — modify — retry iff `code === 'ELOCKED'`, bounded, yielding.
  Invariant: no competing signals; the error code is the whole decision.

## 1. Over-block
None added. A request that used to 409 on contention now succeeds once the tick releases.

## 2. Under-block
None: validation, dark-feature 503, predicate-fact 400 and every non-lock refusal are unchanged
and answered on the first attempt (asserted).

## 3. Level-of-abstraction fit
Route level is the only level with an event loop to yield; the authority is synchronous by
contract and its tests assert synchronous throws.

## 4. Signal vs authority compliance
No new authority. Same principal, same route, same outcomes; only transient contention is absorbed.

## 5. Interactions
Holds the HTTP request open up to ~2 s under contention (was: immediate 409). `freeze()` has the
same sync-lock pattern from a synchronous caller chain; not changed here, tracked as ACT-033.

## 6. External surfaces
None. Response shapes unchanged.

## 7. Multi-machine posture
Machine-local by nature (the lock is on this machine's state file); no replication involved.

## 8. Rollback cost
Revert one route block.

## Class-Closure Declaration

- `unbounded-self-action` — closure: **n/a** (negative declaration). A bounded retry inside a
  single HTTP request (max 100 attempts, ~2 s), triggered only by that request; no timer, no
  re-trigger, no loop beyond the request's lifetime.

## Conclusion
Ship. Tests: `tests/integration/window-run-liveness-register-lock-retry.test.ts` (retry to
success; non-lock error not retried; budget exhausted → 409) and the previously failing e2e
passing 3/3 under the same load.
