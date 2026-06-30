# Side-Effects Review — Reconciler Boot-Ordering Fix (late-bound self-id)

**Version / slug:** `reconciler-meshself-ordering-fix`
**Date:** 2026-06-30
**Author:** echo (autonomous run, topic 28744)
**Second-pass reviewer:** echo second-pass subagent (touches the reconciler decision surface)

## Summary of the change

The WS1.3 `OwnershipReconciler` was wired in `server.ts` inside `if (_topicPinStore && _meshSelfId)` at
line ~16917 — but `_meshSelfId` is not assigned until line ~17877 (~950 lines later in the synchronous boot
flow). So the guard was always null → the reconciler was NEVER constructed and never ticked. Live-confirmed:
0 `OwnershipReconciler` lines in the server log; `/pool/reconciler` 503s even with both machines online. This
is the identical boot-ordering bug already fixed for the sibling `OwnershipApplier`
(`ownership-applier-meshself-ordering-fix`), which made its self-id a late-bound getter. This change applies
the same pattern to the reconciler: (1) gate construction on `_topicPinStore` ALONE; (2) make the `selfMachineId`
dep a getter `() => string | null`, read at tick time; (3) a tick while the id is still null is a strict no-op
(`skipped: 'self-id-unresolved'`). Files: `src/core/OwnershipReconciler.ts` (dep + reads + null guard + skipped
type), `src/commands/server.ts` (gate + getter), plus the two test construction sites and a new regression test.

## Decision-point inventory

- `OwnershipReconciler.tick()` decision FSM — **modify** — now resolves self-id via getter at the top and
  no-ops the whole tick while null (never acts without a resolved self). Otherwise the decision tree is
  byte-identical.
- `server.ts` reconciler construction gate — **modify** — `&& _meshSelfId` dropped (the ordering bug);
  construction now happens, self-id arrives late.

## 1. Over-block

No message block/allow surface. The only added "refusal" is the tick no-op while self-id is null — that is
strictly MORE conservative than before (before, the loop never ran at all; now it runs but waits for the id).
A legitimate action is never blocked once the id resolves (which happens within the first boot).

## 2. Under-block

The self-id null window is bounded to early boot (the id is assigned synchronously during the same boot). A
tick in that window no-ops; the interval keeps ticking, so the first post-id tick acts. No failure mode is
newly missed — the reconciler simply starts working where it never did before.

## 3. Level-of-abstraction fit

Correct — this is the exact pattern the sibling `OwnershipApplier` already uses (late-bound `getSelfMachineId`),
extracted from the same boot-ordering bug. It does not add a new authority; it makes an existing (never-running)
one actually run. The alternative (moving the `_meshSelfId` assignment ~950 lines earlier) is far riskier —
many intervening consumers assume the current ordering.

## 4. Signal vs authority compliance

Compliant. The reconciler's authority (cooperative transfer / force-claim within the FSM) is unchanged. The
late-bound self-id is a wiring correction, not a new decision. The force-claim path still gates on
death-evidence + quorum from machine liveness. A null-self tick is a no-op, never an action.

## 5. Interactions

The late-bound getter mirrors the applier's, so both now resolve self-id consistently at tick time. No
double-fire (one reconciler instance, one timer). The null-guard sits before any machinery, so a partial
boot can't drive a half-initialized tick. The `skipped: 'self-id-unresolved'` value is additive to the
report union.

## 6. External surfaces

`/pool/reconciler` now returns real status (not 503) once the server boots — this is the intended fix
(the route exposed the bug). No new route/config. The reconciler beginning to actually tick is the
behavioral change; it remains dark/dev-gated (`ws13Reconcile`), so the fleet is unaffected; a dev agent's
reconciler now runs (in dry-run unless `ws13DryRun:false`).

## 7. Multi-machine posture (Cross-Machine Coherence)

This is squarely a multi-machine fix. The reconciler is **machine-local BY DESIGN** (each machine reconciles
its own view against the shared journal). The fix ensures it is actually constructed on every machine that
has a pin store. A single-machine agent still no-ops (machines() < 2). The self-id getter reads the same
`_meshSelfId` every other multi-machine consumer uses.

## 8. Rollback cost

Cheap. The reconciler is dark/dev-gated (`ws13Reconcile` resolves dark on the fleet, live on a dev agent) and
defaults to dry-run (`ws13DryRun !== false`). Back-out: set `ws13Reconcile` off (reconciler no-op) or
`ws13DryRun:true` (logs, no CAS). No data migration, no state repair — a config flip. The change is also a
pure wiring/ordering correction with no schema impact.

## Second-pass reviewer response

**Concur with the review.** An independent reviewer verified all five points against the code: (1) the
null-self-id tick is a strict no-op — `const self = this.d.selfMachineId()` then `if (!self) { skipped =
'self-id-unresolved'; return }` precedes `effectivePins()` and every `act()`/CAS; (2) every `selfMachineId`
read goes through the getter `()` (deriveLocalPinHlc, tick, act, explainTopic, status) — none left as a bare
property; (3) `server.ts` gates on `if (_topicPinStore)` alone and passes `selfMachineId: () => _meshSelfId`;
(4) the constructor only stores `deps` — it never captures the id at construction, so late-binding holds; (5)
no stale/transient-null unsoundness — `_meshSelfId` is a module var assigned once (null→value, never reverts),
the only window is early boot which the guard covers, and the `?? ''` in `act()` is reached only after the
tick guard (never an empty-sender CAS in practice). The pattern exactly mirrors the already-shipped
`OwnershipApplier` fix. Not a correctness or safety defect.
