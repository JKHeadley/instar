# Side-Effects Review — Reconciler Pin-Store Boot-Ordering Fix

**Version / slug:** `reconciler-pinstore-ordering-fix`
**Date:** 2026-06-30
**Author:** echo (autonomous run, topic 28744)
**Second-pass reviewer:** echo second-pass subagent (reconciler decision surface)

## Summary of the change

Completes #1312. The `OwnershipReconciler` construction in server.ts was gated `if (_topicPinStore)`,
but `_topicPinStore` is assigned ~2200 lines LATER in the synchronous boot flow (line ~19134 vs the
reconciler block ~16924) — so the gate was always null and the reconciler was STILL never constructed
even after the `_meshSelfId` fix. Live-confirmed: Mini on 1.3.700, `/pool/reconciler` still 503, 0
ticks. Fix: gate construction on `ownReg` (the ownership registry, available at the block since ~16885,
inside `if (durableOwnershipOn)`), and make `pinStore` a late-bound getter `() => TopicPlacementPinStore
| null` read at tick time — the SAME pattern as `selfMachineId` (#1312) and the sibling OwnershipApplier.
A tick while the store is still null yields no pins (a natural no-op). Files: `src/core/OwnershipReconciler.ts`
(dep getter + null-safe effectivePins), `src/commands/server.ts` (gate + getter), tests.

## Decision-point inventory

- `OwnershipReconciler` construction gate (server.ts) — **modify** — `if (_topicPinStore)` → `if (ownReg)`
  (the late-null pin store no longer blocks construction; ownReg is always set within durableOwnership).
- `OwnershipReconciler.effectivePins()` — **modify** — reads the pin store via the getter, null-safe
  (no pins while null → natural no-op).

## 1. Over-block

No message surface. The only "refusal" is a tick yielding no pins while the store is null (early boot) —
strictly more conservative than before (before, the loop never ran at all). Once the store resolves, no
legitimate pin is missed.

## 2. Under-block

The null-store window is bounded to early boot (the store is assigned synchronously during boot). A tick
in that window no-ops; the interval keeps ticking, so the first post-assignment tick acts. No failure mode
is newly missed — the reconciler simply starts working where it never did.

## 3. Level-of-abstraction fit

Correct — identical late-binding pattern to #1312 + the OwnershipApplier. The alternative (relocating the
construction ~2200 lines down to after the pin store) is far riskier (scope, ordering of intervening
consumers). Late-binding makes the construction independent of boot order — the robust fix.

## 4. Signal vs authority compliance

Compliant. The reconciler's authority (cooperative transfer / force-claim within the FSM) is unchanged.
A late-bound pin store is a wiring correction, not a new decision. A null-store tick is a no-op, never an
action.

## 5. Interactions

The pin-store getter mirrors the self-id getter; both resolve at tick time. No double-fire (one instance,
one timer). With both late deps now getters, the construction no longer depends on the assignment order of
ANY late var — closing the whole ordering-bug class. The advisory-pin read path is unchanged.

## 6. External surfaces

`/pool/reconciler` now returns real status (not 503) once the reconciler constructs — the intended fix.
No new route/config. The reconciler beginning to actually tick is the behavioral change; it remains
dark/dev-gated (`ws13Reconcile`), so the fleet is unaffected; a dev agent's reconciler now runs.

## 7. Multi-machine posture (Cross-Machine Coherence)

A multi-machine fix. The reconciler is machine-local BY DESIGN (each machine reconciles its own view
against the shared journal). The fix ensures it is actually constructed on every machine with an
ownership registry (i.e. every durable-ownership / multi-machine machine). Single-machine still no-ops
(machines() < 2).

## 8. Rollback cost

Cheap. Dark/dev-gated (`ws13Reconcile`), dry-run default (`ws13DryRun !== false`). Back-out = a config
flip. Pure wiring/ordering correction, no schema impact.

## Second-pass reviewer response

**Concur with the review.** An independent reviewer verified all four points against the code: (1) `ownReg` is truthy at the construction gate (`sessionOwnershipRegistry` constructed at server.ts:16878, `ownReg` at 16885, both before the `if (ownReg)` gate at 16930) — and noted the registry is constructed unconditionally, which is immaterial/safe because the reconciler's own gates (`enabled()` via the `ws13Reconcile` dev-gate, and the `machines().length < 2 → skipped:'single-machine'` early return) keep it inert when it shouldn't act; (2) `pinStore` is read null-safely (the only runtime read is `const ps = this.d.pinStore(); const local = ps ? ps.all() : {}`); (3) **no THIRD late-assigned construction dep** — of the 10 deps, only `ownership: ownReg` is a direct value (resolved at 16885, before construction); every other dep is a getter/closure read at tick time, and the two module values read inside them use optional chaining; (4) a null-pinStore tick truly no-ops (`effectivePins()` returns `{}`, the loop never executes, zero CAS; plus `dryRun` defaults true). The fix correctly completes #1312.
