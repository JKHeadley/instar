# Reconciler Pin-Store Boot-Ordering Fix — completes #1312

## What Changed

Completes #1312. The cross-machine convergence loop (`OwnershipReconciler`) was gated on `_topicPinStore`, which is assigned ~2200 lines LATER in the synchronous server boot than the loop is wired — so the gate was always null and the loop was STILL never constructed even after the `_meshSelfId` fix (live-confirmed: Mini on 1.3.700, `/pool/reconciler` still 503, 0 ticks). Fix: gate construction on the ownership registry (ready early) and read the pin store via a late-bound getter at tick time — the same pattern as #1312 and the sibling `OwnershipApplier`. With both late dependencies now read at run-time, the loop's construction no longer depends on boot order at all.

## Evidence

- Unit: `tests/unit/OwnershipReconciler.test.ts` — 33 tests incl. a new regression test (a null pin store at boot is a no-op even with a triggering pin; once it resolves, the SAME instance transfers) alongside the #1312 self-id regression tests — both late deps now guarded.
- All `new OwnershipReconciler` construction sites updated to the late-bound pin-store shape. Build clean.

## What to Tell Your User

Nothing yet — the convergence loop remains off by default (dev-gated). This completes the wiring so that when it is enabled, the loop is actually built and runs (it never was before). No change to normal use.

## Summary of New Capabilities

- (Dark) The cross-machine convergence loop is now actually constructed on every multi-machine machine — both startup-ordering bugs that kept it from being built are fixed.
