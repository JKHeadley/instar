# Side-Effects Review — Cross-Machine Ownership-Reconciler Convergence

**Version / slug:** `cross-machine-reconciler-convergence`
**Date:** 2026-06-30
**Author:** echo (autonomous pre-approved run, topic 28744)
**Second-pass reviewer:** echo second-pass subagent (high-risk: ownership/routing decision surface)

## Summary of the change

Closes the cross-machine "stuck move" bug: a conversation pinned to machine T while machine S still owns it never converged. Three root causes, all live-verified Laptop↔Mini: (1) a false-positive **clock-skew quarantine** — `refreshPool()` fed the coarse git-synced file heartbeat's timestamp into the live 5-min clock-skew FSM, permanently quarantining the peer (fix: a `coarseHeartbeat` flag so coarse beats refresh liveness but never drive the skew FSM); (2) the **pin (move-intent) never replicated** to the owning machine (fix: a new `topic-pin-record` replicated-record kind on the WS2 rails + `TopicPinReplicatedStore` advisory consumer + reconciler HLC-precedence between local and advisory pins, validated known+online); (3) the **`transferring` handoff signal never replicated** (fix: extend `PlacementData` with `status`/`transferTo`/`timestamp`/`drainInFlight`, thread it at the shared `emitPlacement` helper, and have `OwnershipApplier` materialize the transferring state — validated `transferTo`, epoch-fenced, timestamp-clamped — so the target machine claims). Plus a stuck-transferring `abort-transfer` recovery case, the `/pool/reconciler` observability route, and the **testing-integrity root fix**: `makeSim` rebuilt so every reconciler test runs separate-per-machine stores joined only by a journal pump (the shared-store harness masked this bug for months). Files: `MachinePoolRegistry.ts`, `CoherenceJournal.ts`, `OwnershipApplier.ts`/`ownershipApplierWiring.ts`, `OwnershipReconciler.ts`, `TopicPlacementPinStore.ts`, new `TopicPinReplicatedStore.ts`, `server.ts`, `routes.ts`, `AgentServer.ts`, tests. Decision points touched: the WS1.3 OwnershipReconciler (ownership transfer/claim/abort), the OwnershipApplier (cross-machine ownership materialization), the clock-skew quarantine FSM.

## Decision-point inventory

- `OwnershipReconciler.tick()` (ownership transfer/claim/force-claim/abort) — **modify** — now reads an effective pin (local + HLC-ordered advisory) + a new abort-transfer recovery case; still epoch-fenced + death-evidence-gated, never a brittle timer steal.
- `OwnershipApplier.tick()` (materializes replicated ownership) — **modify** — now materializes `transferring` (validated `transferTo`→downgrade, epoch-fenced, timestamp-clamped), not only `active`.
- `MachinePoolRegistry.recordHeartbeat()` clock-skew FSM — **modify** — a `coarseHeartbeat` beat no longer drives the FSM (abstains; liveness only).
- `topic-pin-record` replicated kind + `TopicPinReplicatedStore` — **add** — advisory move-intent replication (HLC, tombstone, quarantine via the WS2 envelope).
- `GET /pool/reconciler` — **add** — read-only observability (status + per-topic explain); 503 when absent.

## 1. Over-block

No block/allow message surface. The closest "reject" behaviors are protective and tightly scoped: a replicated `transferring` whose `transferTo` is unknown/offline/==owner is DOWNGRADED to `active(owner)` (never materialized as un-claimable) — it does not reject a legitimate handoff, it falls back to the safe state; an advisory pin toward an offline/unknown machine is ignored (the move waits, never misroutes). A legitimate handoff to a known+online machine is never downgraded. Over-rejection risk: a brief window where a just-joined machine isn't yet in `machines()` could make a valid advisory pin/transferTo read as "unknown" → the move waits one tick until membership populates (self-healing, not a permanent block).

## 2. Under-block

A genuinely STALE peer stream is the in-scope adversary (single-agent model — no hostile tenant). Residual misses, all bounded: a corrupt future-dated `timestamp` is clamped (can't defeat the deadline); a corrupt huge epoch is fenced; a stale pin is HLC-ordered out by a fresher one AND requires an online target. What it does NOT yet cover (documented follow-ups, tracked): `pendingReplacement` honest-pending surfacing for a not-yet-converged advisory move, and an explicit tombstone-on-clear emit from `/pool/transfer` (today a clear relies on a re-pin's higher HLC). These are additive surfacing/cleanup, not correctness holes — convergence still completes; the gap is only the "still moving" UX cue and faster clear propagation. <!-- tracked: CMT-1829 -->

## 3. Level-of-abstraction fit

Correct layer. The fixes sit exactly where the decisions already live: the clock-skew abstention is in the registry that owns the FSM; the pin replication rides the EXISTING WS2 replicated-record machinery (HLC envelope, tombstone, quarantine, retention) rather than a new bespoke transport (Round-1 review explicitly rejected a wall-clock `topic-pin` kind); the transferring replication extends the EXISTING placement journal + applier rather than a parallel path. The reconciler consumes signals (advisory pins, machine liveness) and acts within the existing FSM/CAS authority — it does not add a new authority.

## 4. Signal vs authority compliance

Compliant. A replicated pin is a **signal** (advisory move-intent). The reconciler's effective-pin merge IS read by every branch (including force-claim Case C when the pin names self), but the force-claim DECISION is gated on death-evidence + quorum derived from machine LIVENESS (`machines()`), never on the advisory pin — a stale/corrupt pin cannot manufacture death evidence, so it can never cause a LIVE-owner seat-steal. The only thing an advisory pin can trigger is the owner's OWN cooperative transfer (owner-gated FSM action). The clock-skew change REMOVES a brittle authority (a coarse file timestamp was wrongly gating placement eligibility). `/pool/reconciler` is observe-only. No brittle check gains blocking authority.

## 5. Interactions

The transferring extension threads through the SHARED `emitPlacement` helper so every CAS site (reconciler, drain runner, user-move) emits coherently — avoids the "only the reconciler path threads it" shadow. The applier's owner-anchored equal-epoch tie-break prevents a forged peer `active(e)` from shadowing the true owner's `transferring(e)`. The advisory pin is unioned with the local pin (HLC precedence) so a stale local self-pin can't shadow a fresher replicated intent (the N3 recurrence). No double-fire: the journal op-key dedupes a same-(recordKey,hlc) retry. The abort-transfer is owner-only (FSM-gated), so two machines can't both abort.

## 6. External surfaces

New: `GET /pool/reconciler` (Bearer-gated, credential-free — topic ids/machine ids/epochs/decision reasons only). New journal kind `topic-pin-record` (additive — older peers ignore unknown kinds; the feature converges only when BOTH machines are new, a degrade to the pre-fix stuck-move, never a regression). New config flag `multiMachine.seamlessness.ws13PinReplicate` (dev-live/fleet-dark). The cross-machine convergence latency is eventually-consistent (~45–90s) — surfaced honestly. Timing/runtime dependence: convergence depends on the journal replicating (best-effort HTTP pull) — a lost pin record delays (never corrupts) a move; the reconciler retries each tick.

## 7. Multi-machine posture (Cross-Machine Coherence)

This change IS the multi-machine feature. Posture per surface: `topic-pin-record` = **replicated** (WS2 rails, HLC; advisory-on-receive, local pin write stays router-authenticated); `topic-placement` status/transferTo = **replicated** (existing placement journal + applier); `TopicPinReplicatedStore` = **machine-local view of replicated data**; `/pool/reconciler` = **proxied-on-read** via the standby (503 when dark); reconciler tick / appliers = **machine-local BY DESIGN** (each reconciles its own view; the journal is the shared arbiter). No single-machine assumption — a single-machine agent is a strict no-op (no peers → no advisory pins, the reconciler `machines()<2` no-ops). User-facing: a non-converging move surfaces via the reconciler explain + (follow-up) pendingReplacement — no silent stuck state.

## 8. Rollback cost

Cheap and layered. Everything ships dark behind `ws13Reconcile`/`ws13DryRun` (dev-live/fleet-dark) + `ws13PinReplicate` (independent sub-flag for the pin-replicator). Back-out paths, in order: set `ws13PinReplicate` off (stops pin emission — the topic-pin store entry is absent → the emitter no-ops); set `ws13DryRun` true (reconciler logs but lands no CAS); set `ws13Reconcile` off (reconciler strict no-op). No data migration needed — the new `topic-pin-record` stream is additive and self-prunes (retention rotateKeep:4); the `TopicPin.hlc` field is optional (absent ⇒ derived-from-updatedAt fallback). No agent-state repair. A bad release is a config flip, not a hot-fix.

---

## Second-pass reviewer response

**Concur with the review.** An independent reviewer verified every load-bearing safety claim against the code: (1) signal-vs-authority — a replicated pin can only yield a `preferredMachine` the owner transfers TOWARD; Case A fires only when `owner === self` (the owner releasing its own topic), and the force-claim Case C is gated independently on death-evidence + quorum from `machines()` liveness, so a stale/corrupt pin cannot manufacture a live-owner steal (confirmed OwnershipReconciler.ts effectivePins + Case A/C); (2) the applier's `transferTo` validation→downgrade, epoch fence, and timestamp clamp match the code exactly; (3) the coarse-heartbeat abstention genuinely never drives the skew FSM while still refreshing liveness; (4) the threading + route + multi-machine posture + rollback all check out. The one concern raised was a §4 phrasing imprecision ("never reads the advisory store") — corrected above to credit the death-evidence+quorum gate (the actual safety mechanism) rather than overstating store isolation. Not a correctness or safety defect; the code's behavior was already safe.
