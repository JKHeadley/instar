# Side-Effects Review — Speaker-Election Owner-Liveness

**Version / slug:** `speaker-election-owner-liveness`
**Date:** `2026-07-11`
**Author:** `echo`
**Second-pass reviewer:** `spec-converge (3 rounds; adversarial + integration found + folded 4 material findings, round-3 verdict CONVERGED) + this artifact`

## Summary of the change

Closes "a dark owner must not silently hold a topic's voice" (CMT-1956/ACT-1190) in `SpeakerElection.decideInner`, the multi-machine one-voice authority — but does it in three safe layers because the naive fix was proven unsafe. Files: `src/monitoring/SpeakerElection.ts` (Layer 1 guard + 2 deps), `src/core/MachineHeartbeat.ts` (Layer 0 pure predicate), `src/commands/server.ts` (Layer 0 use at the coarse pool-refresh loop + Layer 1 dep wiring). **Layer 0** fixes a real standalone liveness-signal bug: the coarse loop re-recorded EVERY git-synced heartbeat every ~30s, stamping a fresh local receipt, so a dead peer stayed `online:true` forever — a `heartbeatFreshEnoughToRerecord` gate (skip when `lastHeartbeatAt` older than ≥2× the ~30-min write cadence) makes `online` expire honestly; lands live. **Layer 1** adds the self-safe owner-liveness guard (`liveOwner === self || pool.includes(liveOwner)`) to rules 1 & 2, but DARK/observe-only (dev-gated flag, default dryRun) — the verdict is unchanged at ship; a dark owner's would-fall-through is only recorded. **Layer 2** (the live enforce-flip) is deferred (ACT-1196) behind a soak + sustained-dark condition.

## Decision-point inventory

- `SpeakerElection.decideInner` rules 1 & 2 owner-defer — modify (observe-only at ship) — `invariant`: deterministic liveness test; verdict unchanged until the deferred enforce-flip.
- Layer-0 coarse heartbeat re-record — modify — `invariant`: deterministic freshness gate; corrects an over-permissive `online`.

## 1. Over-block

The guard is DARK/observe-only, so it BLOCKS nothing at ship (verdict unchanged). Layer 0 could "over-expire" a peer only if `lastHeartbeatAt` were stale despite the peer being live — but a live peer writes every ~30 min and the cutoff is ~60 min, so it never expires a live peer (unit-tested at the boundary + the one-cadence-old case).

## 2. Under-block

At ship, a dark owner STILL holds the voice (observe-only) — the bug isn't fixed live yet; that is deliberate (measure before enforcing). The residual after the enforce-flip is the split-view double-speak window (adversarial-F1/integration-F3), collapsed by the sustained-dark condition and backstopped downstream by the per-event dedup ledger + duplicate-text suppression — documented, tracked (ACT-1196).

## 3. Level-of-abstraction fit

Right layer. Layer 0 fixes the liveness signal AT the signal (MachineHeartbeat/the coarse loop), where every liveness read benefits. Layer 1 is exactly the election that owns the voice decision; it mirrors rule 4's existing dark-holder pattern. The enforce-flip is correctly deferred to a rollout decision, not baked in.

## 4. Signal vs authority compliance

The guard holds authority only over a closed-world deterministic test (`owner ∈ online-pool`), and at ship it changes no verdict at all (observe-only) — it cannot mis-block. The enforce-flip, when it lands, tightens an existing invariant deterministically. No brittle open-domain check. The Layer-0 gate is a pure freshness predicate.

## 5. Interactions

- The `single-machine` early-guard (`pool.length < 2`) still fires first — the guard only engages on a ≥2-machine online pool (test covers this).
- Rule 4's existing dark-holder tiebreak is the fall-through target when enforcing — unchanged; the guard just widens dark-fallthrough to rules 1/2.
- Layer 0 preserves the `coarseHeartbeat: true` marker (no clock-skew-quarantine interaction — the 2026-06-30 fix stays intact); it only ADDS a skip for stale records.
- Downstream dedup ledger + duplicate-text suppression backstop any future enforce-mode transient overlap.

## 6. External surfaces

No new route/actor/user-notice. One new dev-gated config path (`monitoring.speakerElection.ownerLiveness`, default observe-only) and a bounded observe log line (`[SpeakerElection.ownerLiveness]`, captured in the size-rotated server log). No timing dependence beyond the heartbeat cadence it already reads.

## 7. Multi-machine posture

This IS the multi-machine one-voice decision. The liveness input is each machine's LOCAL view (not replicated consensus) — honestly stated in the spec (no "≤1 by construction" claim). Layer 0 makes the local signal honest (unified improvement to every read); Layer 1 ships observe-only so it changes no verdict and cannot break the invariant while measured; the enforce-flip is gated on sustained-dark + downstream dedup backstops. No per-machine durable state beyond the bounded observe log.

## 8. Rollback cost

Revert the PR. Layer 0 reverts `online` to the prior over-permissive reading (a dead peer looks online again — the status quo). Layer 1 is dev-gated dryRun, so reverting changes nothing live. No migration, no data. The enforce-flip is not in this PR.

---

## Second-pass review

**Concur with the review.** Driven through 3 `/spec-converge` rounds: round 1 found 3 material findings (the signal-pollution no-op, the self-silence edge, and the ≤1-vs-≥1 trade), round 2 found the threshold mis-calibration, all folded with code-grounded fixes; round 3 verified the ≥2×-cadence calibration against the real code (a live git-syncing peer never flaps dark, a dead peer expires) and returned CONVERGED. codex external non-material all 3 rounds. 23 direct tests + a 238-test regression sweep green. No concern raised.
