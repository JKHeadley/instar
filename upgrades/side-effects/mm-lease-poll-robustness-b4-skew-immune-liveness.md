# Side-Effects Review — B4 skew-immune lease liveness (multimachine-lease-poll-robustness, Decision 10)

**Change:** Derive the lease's `presumedDeadHolders` / `allPeersPresumedGone` peer-liveness from the SKEW-IMMUNE router-observed clock (`MachinePoolRegistry.getCapacity().online`, keyed on `routerReceivedAt`) instead of the peer's skew-contaminated `lastSeen`. Closes the flap's ROOT trigger: under clock skew a slow peer's `lastSeen` looks stale → false failover (the flap); a fast peer's looks fresh → delayed failover. Pure decision extracted to a unit-tested helper `isPeerPresumedDead`; the two server closures call it with a forward-ref to the (later-built) registry. Dev-gated (`leaseSelfHeal.skewImmuneLiveness`, `enabled` omitted → developmentAgent gate); flag off ⇒ byte-for-byte legacy `lastSeen` behavior.

**Files:** `src/core/leaseLiveness.ts` (new pure helper), `src/commands/server.ts` (forward-ref + 2 closures + flag), `src/core/types.ts` + `src/config/ConfigDefaults.ts` (`skewImmuneLiveness`), `tests/unit/leaseLiveness.test.ts`.

## Phase 1 — Principle check (signal vs authority)
Does it gate/block/constrain? It feeds a DECISION (presumed-dead → eligible-to-take-over), so signal-vs-authority applies. The decision logic is NOT brittle: it is a deterministic comparison over a router-observed timestamp (the same skew-immune source `MachinePoolRegistry` already uses for placement). It REPLACES an existing skew-contaminated input to the SAME authority (the lease's `canAcquire`); it adds no NEW blocking authority. The conservative direction is preserved (only positive staleness evidence ⇒ dead; unknown ⇒ alive), so a wrong reading fails toward NOT taking over (the safe direction — a wrongful takeover is the split-brain).

## 1. Over-block
The risk axis here is "wrongly presume a LIVE peer dead" (→ takeover → split-brain). Guarded: skew-immune path is used ONLY when the registry has actually observed the peer this incarnation (`routerObserved`); a known-on-disk-but-not-yet-observed peer (fresh boot) falls back to `lastSeen` rather than being wrongly marked dead (the convergence-review edge, unit-tested).

## 2. Under-block
"Wrongly presume a DEAD peer alive" (→ delayed failover). Under skew this is strictly BETTER than today (a fast-clock peer no longer looks alive forever). Flag off ⇒ unchanged.

## 3. Level-of-abstraction fit
Right layer. The skew-immune source already exists in `MachinePoolRegistry` (used for placement). This routes the SAME source to the lease layer, which previously had its own skew-blind copy — removing a dual-source disagreement rather than adding a layer. The pure helper isolates the decision for testing.

## 4. Signal vs authority compliance
Compliant. The helper is a pure function (no I/O, no authority); it returns a boolean the existing lease authority consumes. No brittle blocking added. (Ref `docs/signal-vs-authority.md`.)

## 5. Interactions
- **soloCaptainHold / staleHolderTakeover:** both consume `allPeersPresumedGone` / `presumedDeadHolders` — they get a more-accurate (skew-immune) input; their own gates (preferred-awake, no-higher-epoch) are untouched. soloCaptainHold ships dark regardless.
- **TDZ safety:** the forward-ref `leaseLivenessRegistry` is a function-body `let`, declared BEFORE the lease block and assigned AFTER the registry is built. During `initializeLease()` (which can call the closures) the ref is still `undefined` → `routerObserved:false` → lastSeen fallback. No throw, safe degrade.
- **No double-source race:** when the registry IS set, both closures read the same live `getCapacity` view; consistent within a tick.

## 6. External surfaces
None new. No route, no message, no log added (the existing lease logs are unchanged). The only observable effect is more-correct failover timing under skew.

## 7. Multi-machine posture (Cross-Machine Coherence)
**Machine-local read of a per-machine observation.** Each machine decides peer-liveness from ITS OWN router-observed clock (`MachinePoolRegistry` is per-machine, in-memory). Nothing replicated/proxied. Single-machine no-op: `peerIds.length === 0` returns false (a solo machine never presumes a peer gone); `presumedDeadHolders` returns an empty set. Dev-gated → dark on the fleet until graduated.

## 8. Rollback cost
Trivial. `leaseSelfHeal.skewImmuneLiveness.enabled:false` (read live each call) → the closures revert to exact legacy `lastSeen` behavior immediately. No state, no migration. The helper + forward-ref are inert when the flag is off (the skew-immune branch is simply not taken).

## Verification
- `npx tsc --noEmit` clean.
- `tests/unit/leaseLiveness.test.ts` 4/4: flag-off legacy threshold; flag-on skew-immune wins over a fast-clock (future) lastSeen AND over a slow-clock (stale-looking) lastSeen (the false-failover that CAUSED the flap); not-yet-observed → lastSeen fallback (no wrongful dead); conservative unknown → not-dead.

## Phase 5 — Second-pass review (high-risk: lease/recovery)
Independent reviewer verdict: **Concur with the review.** Verified TDZ/forward-ref safety (function-scope let, runtime-only invocation, undefined→lastSeen fallback), split-brain safety (the skew-immune path is STRICTLY more conservative in the takeover direction than legacy lastSeen — a skew-quarantined-but-reachable peer stays online:true and is never presumed dead, the flap fix), getCapacity/threshold consistency, live flag resolution, and non-vacuous tests. One optional coverage suggestion (override-to-dead with a fresh lastSeen) — **added** as a 5th test (now 5/5 green). No code change required to ship.
