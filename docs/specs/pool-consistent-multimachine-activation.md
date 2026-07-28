---
title: "Pool-Consistent Activation for Multi-Machine Dev-Gated Features"
slug: "pool-consistent-multimachine-activation"
author: "echo"
parent-principle: "No Silent Degradation to Brittle Fallback"
eli16-overview: "pool-consistent-multimachine-activation.eli16.md"
review-convergence: "2026-06-16T05:45:11.401Z"
review-iterations: 4
review-completed-at: "2026-06-16T05:45:11.401Z"
review-report: "docs/specs/reports/pool-consistent-multimachine-activation-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 3
cheap-to-change-tags: 2
contested-then-cleared: 1
approved: true
approved-by: "echo (autonomous run, standing pre-approval — Justin 2026-06-15 24h run + design-fork autonomy)"
---

# Spec: Pool-Consistent Activation for Multi-Machine Dev-Gated Features

**Status:** CONVERGED (4 rounds) + self-approved under standing autonomous pre-approval
**Tracking:** CMT-1568 (follow-on)
**Earned from:** the live Laptop↔Mini transfer-fix proof (v1.3.589, 2026-06-16).

## 0. The earning incident (the live test that caught it)

The cross-machine transfer fix (`multiMachine.durableOwnership`, dev-gated) shipped in
PR #1188 with 49 green tests, then was held to the new Live-User-Channel Proof standard.
The live Laptop↔Mini proof caught that it was **half-active**:

- The **Laptop**'s echo had `developmentAgent: true` → `resolveDevAgentGate` flipped
  `durableOwnership` LIVE → the durable store + `OwnershipApplier` ran → the transfer
  reported `seatMoved:true`, `placedOwnership:true`, and the durable record showed
  `owner=Mac Mini` (proven on disk).
- The **Mini**'s echo had `developmentAgent: None` → `durableOwnership` resolved **dark**
  → no durable store, no applier. The Laptop's placement journal *did* replicate to the
  Mini (the `peers/<laptop>.topic-placement.jsonl` exists), but **nothing on the Mini
  materialized it** → the Mini never learned it owned the topic → a real message would
  still mis-route. The seat moves on one side and dies on the other.

**The root flaw (general):** the `developmentAgent` dark-gate resolves **per-machine**
off each machine's local config. A feature that requires **pool-wide** activation is
therefore BROKEN whenever the flag is inconsistent across the agent's machines — and the
same agent ("echo") can trivially have a different `developmentAgent` value per machine.
A per-machine gate on a pool-coordinated feature is a silent split-brain generator.

## 1. Scope

1. Make `multiMachine.durableOwnership` (the transfer fix) activate **pool-consistently**
   so the durable store + applier come up on every machine that participates in the pool's
   ownership replication — not just the dev-flagged one.
2. A **structural backstop** for the whole CLASS: detect + surface a `multiMachine.*`
   feature that is live on some pool machines and dark on others (a split-active pool is
   itself an incident — mirrors the guard-posture tripwire).
3. Re-run the live Laptop↔Mini proof for a genuine PASS (a reply truly served from the
   Mini after a transfer), recording the signed artifact.

Out of scope: a general pool-coordination framework for every feature (this targets the
ownership feature + a detect-and-surface guard for the class).

## 2. Design

### 2.1 The fix — gate on the pool-consistent dependency

`durableOwnership`'s real prerequisite is the **coherence-journal placement replication**
(`multiMachine.coherenceJournal`), which the durable store + applier consume. That
dependency is already enabled **pool-consistently** (on the live pool, `coherenceJournal`
resolved enabled on BOTH machines — the Mini's config carried `enabled: true` explicitly).

So the durable store should activate wherever **its dependency is active**, not where the
local dev flag happens to be set. Concretely (server.ts:14861), replace:

```
durableOwnershipOn = resolveDevAgentGate(multiMachine.durableOwnership.enabled, config)
```

with activation that follows the journal's pool-consistent state:

```
durableOwnershipOn =
   resolveDevAgentGate(multiMachine.durableOwnership.enabled, config)   // dev still opts in
   || coherenceJournalPlacementReplicationActive(config)                // …and any machine
                                                                        //   replicating
                                                                        //   placements
```

This makes the durable store + applier come up on **every machine in the pool that
replicates placements** — which is exactly the set that needs to materialize ownership for
the seat to move. A single-machine agent (no journal replication) stays on the in-memory
store (today's behavior — strict no-op). Design fork (Q1): is "journal-replication-active"
the right pool-consistent signal, or should activation be advertised+converged via the
machine heartbeat (a peer-sees-peer-active convergence)? Lean: gate on the journal
dependency — smallest-correct, no new coordination protocol, and the dependency is already
pool-consistent.

### 2.2 The backstop — split-active pool detection (the class)

Add a guard (periodic, observe-only, mirroring the GuardPostureProbe): for each
`multiMachine.*` feature flagged pool-coordinated, compare its **effective activation
across the pool** (via the existing `GET /guards?scope=pool` fan-out). If a feature is
live on some machines and dark on others → raise ONE aggregated, deduped Attention item
("durableOwnership is split-active across your pool — the Mini is dark; the feature is
broken until consistent") + a `logs/guard-posture.jsonl` row. This is *No Silent
Degradation* applied to pool activation — a half-active pool feature can never be silently
broken again. (Design fork Q2: signal-only vs. also auto-converge. Lean: signal-only first;
auto-converge is §2.1's job.)

### 2.3 Generalize the lesson (Structure > Willpower)

- Doc: the dark-gate convention (`devGatedFeatures.ts` header + the constitution's relevant
  standard) gains: "a `multiMachine.*` feature MUST NOT rely on a purely per-machine
  `developmentAgent` gate — it must activate pool-consistently (gate on a pool-consistent
  dependency/signal) OR carry a split-active detector."
- Lint (Q3 — lean: add it): a CI check that a NEW `multiMachine.*` entry in
  `DEV_GATED_FEATURES` carries a `poolConsistent: true|false` declaration + (when true) a
  reference to its pool-consistent activation path — so the next such feature can't ship the
  same flaw silently.

## 3. Acceptance criteria

1. `durableOwnership` activates on every pool machine replicating placements (verified:
   the Mini's echo log shows `[ownership] durable LocalSessionOwnershipStore active` + the
   applier materializes a replicated placement), with single-machine agents a strict no-op.
2. The split-active detector raises ONE aggregated Attention item when a pool-coordinated
   feature is live-on-some / dark-on-others; clears when consistent. Observe-only.
3. **The live re-proof (the bar):** deploy to both machines, transfer a throwaway topic
   Laptop→Mini, send a REAL message, confirm the reply is served FROM the Mini
   (`responderMachine=mini`, `seatMoved:true`), reverse Mini→Laptop, record the signed
   live-test artifact (via `LiveTestArtifactStore`).
4. Unit + integration + e2e per the Testing Integrity Standard; zero-failure; migration
   parity for the doc/convention change.

## 4. Frontloaded Decisions

- **D1 — activation signal.** REVISED after round-1 review (both reviewers flagged the
  original as under-specified / flag-conflating). The fix is modeled as **POOL-SCOPED
  activation on an invariant**, not a loose `dev || dependency` OR:
  > **Invariant:** *every machine that CONSUMES replicated placement journals must run the
  > durable ownership store + `OwnershipApplier`; no placement journal may run without the
  > applier where durable ownership records exist.*
  The activation predicate keys on the **explicit, already-pool-consistent**
  `multiMachine.coherenceJournal.replication.enabled === true` signal (NOT the dev-gated
  `coherenceJournal.enabled`, and NOT the per-machine dev flag) — verified in the live
  incident: the Mini carried `coherenceJournal.enabled:true` explicitly yet durableOwnership
  was dark purely on the dev flag. Gating on `replication.enabled` (operator-set,
  non-dev-gated, pool-consistent by deployment discipline) is what genuinely fixes it.
  This is **production promotion** of the durable store wherever placement replication is
  on — disclose the blast radius (it's pool-scoped activation, not local dev). _Reversibility:
  NOT cheap — it changes the activation MODEL (local→pool-scoped) + promotes the feature past
  the dev ladder; frontloaded with the invariant + blast-radius disclosure._
- **D2 — backstop strength.** DECIDED: signal-only split-active detector first (an
  Attention item + log row), no auto-disable. _Reversibility: cheap — observe-only._
- **D3 — generalization.** DECIDED: doc the convention + add the CI lint for new
  `multiMachine.*` dev-gated features. _Reversibility: cheap — docs + a lint._

## Round-1 review findings to fold (next convergence cycle)

Both reviewers (internal panel + codex external, verdict SERIOUS) converged on these — to
address in the next round before convergence:

1. **Precise activation predicate (HIGH) — GROUNDED.** The exact signal is
   `config.multiMachine?.coherenceJournal?.replication?.enabled === true` — the SAME
   `_replicationEnabled` value computed at **server.ts:16588** that already gates the
   `journalSyncApplier` (16592, `_replicationEnabled && journalSyncApplier`). It is explicit
   (`=== true`, ConfigDefaults leaves it absent — 16585) and NOT dev-gated. So the fix at
   server.ts:14861 becomes:
   ```
   const _replicationOn = (config.multiMachine?.coherenceJournal as
     { replication?: { enabled?: boolean } } | undefined)?.replication?.enabled === true;
   const durableOwnershipOn = resolveDevAgentGate(durableOwnership.enabled, config) || _replicationOn;
   ```
   The invariant: *a machine that runs the placement-replication applier (`journalSyncApplier`,
   gated on `_replicationOn`) MUST also run the ownership applier + durable store* — they
   consume the same replicated placements. This is **pool-scoped production promotion** of the
   durable store wherever replication is on; disclose the blast-radius (it activates on every
   replication-enabled pool machine, not just dev).
2. **Detector = deterministic activation-health record (MEDIUM).** The incident was a
   config-vs-materialized-behavior mismatch. The split-active detector must compare
   **effective runtime** activation, not raw config — each pool-coordinated feature exposes
   `{configured, effective, dependencyActive, componentStarted, lastAppliedPeerJournal}` via
   `GET /guards?scope=pool`; the detector flags when `effective` diverges across peers.
3. **Rolling-deploy + boot-race (MEDIUM).** Old code (pre-gate) won't materialize a new
   machine's placements mid-deploy → half-applied transfer. Document the safe deploy
   sequence; the `OwnershipApplier` must **backfill** materializations on first run (scan
   existing replicated placements at activation), so a boot-before-peer machine converges.
4. **Detector false-positives (LOW→MED).** Suppress during a known version-mismatch
   (rolling deploy — compare peer versions in the heartbeat) and honor a `poolConsistent:false`
   silence for features SUPPOSED to drift; define the de-dup/clear window.
5. **Evaluate the capability-handshake alternative (MED).** Add a tradeoff table:
   dependency-following (lean) vs heartbeat capability-gossip (peers advertise
   `durableOwnershipActive`, refuse a transfer to a peer lacking it — fail-closed, arguably
   safer) vs pool-config. The capability-refuse option may be the safest: a transfer to a
   peer that can't materialize is REFUSED (honest `seatMoved:false`) rather than half-moved.
6. **Testable lint, not paperwork (MED).** The `poolConsistent` invariant should be
   CI-asserted (e.g. a test that a `multiMachine.*` dev-gated entry resolves the same across
   a simulated 2-machine config), not just a declaration string.

## Round-2 resolution of the findings

1. **Predicate (HIGH) — RESOLVED above:** gate on `_replicationEnabled` (the grounded
   `coherenceJournal.replication.enabled === true` signal at server.ts:16588), the same one
   gating `journalSyncApplier`.
2. **Detector activation-health record (MED) — ADOPTED:** each pool-coordinated feature
   exposes `{configured, effective, dependencyActive, componentStarted, lastAppliedPeerJournal}`
   in `GET /guards?scope=pool`; the detector compares **effective** (runtime) across peers, not
   raw config (the incident was a config-vs-behavior mismatch — comparing config alone would
   have missed it). Signal-only: ONE aggregated, deduped Attention item; clears on consistency.
3. **Boot-before-peer race (MED) — ALREADY HANDLED by the applier's design:** `OwnershipApplier.
   tick()` queries the recent placement journal each tick (not new-only) and materializes any
   entry with epoch > local — so a machine that activates AFTER placements arrived BACKFILLS
   them on its first tick. No new code needed; add a test asserting backfill-on-activation.
4. **Detector false-positives (LOW→MED) — RESOLVED:** the detector compares peer VERSIONS
   (from the heartbeat) and suppresses while a rolling deploy is in flight (mixed versions);
   honors a `poolConsistent:false` silence flag (a feature meant to drift); a single-machine
   agent (no peers) never fires. Dedup/clear window = the GuardPostureProbe's existing cadence.
5. **Capability-handshake alternative (MED) — EVALUATED, dependency-following CHOSEN as primary;
   capability-REFUSE adopted as the rolling-deploy safety net.** Tradeoff:
   - *Dependency-following* (the §2.1 fix): smallest-correct, no new protocol, converges the
     pool. Weakness: a brief rolling-deploy window where the old machine lacks the gate.
   - *Capability-handshake/refuse*: a machine advertises `durableOwnershipActive` in its
     heartbeat; `/pool/transfer` REFUSES a move to a peer NOT advertising it (honest
     `seatMoved:false` + reason) rather than half-moving. This is the **fail-closed** safety net
     for the rolling-deploy gap — a transfer to a not-yet-upgraded peer is refused, never
     half-applied. ADOPTED as a thin guard on top of dependency-following (the §7.3 of the main
     spec already has the `seatMoved:false` honesty surface to reuse).
   - *Pool-config push*: rejected — adds a config-distribution dependency.
6. **Testable lint (MED) — ADOPTED:** the lint asserts the INVARIANT, not paperwork — a test
   applies the real ConfigDefaults to a simulated 2-machine pool (one dev, one not, replication
   on) and asserts a `multiMachine.*` feature marked `poolConsistent:true` resolves the SAME
   effective activation on both. A new such feature that resolves split fails CI.

## Round-3 fold (codex r2, MINOR — converging)

1. **Replication-config drift is the SAME class — the detector covers it.** `replication.enabled`
   could itself drift across peers. The §2.2 detector compares **effective** activation, which
   IS the materialized result of replication+ownership — so a replication-drift split surfaces
   the same way (one peer applying placements, one not). State explicitly: the detector's unit of
   comparison is *effective ownership materialization*, which catches both the dev-flag drift
   (the original incident) AND replication-config drift. No separate invariant needed.
2. **Capability-refuse heartbeat contract (freshness).** The advertised record is
   `{machineId, version, replicationEnabled, durableOwnershipActive, lastAppliedPlacementEpoch,
   observedAt}`. `/pool/transfer` refuses a move to a target whose record is STALE (observedAt
   older than `2×heartbeatInterval`) OR not `durableOwnershipActive` OR version-incompatible —
   **fail-closed**: an unconfirmed-active target is refused (`seatMoved:false`, reason names the
   missing field), never half-moved. A stale heartbeat thus errs toward refusal, never a false
   permit.
3. **Detector must not depend solely on the system it validates.** Each machine writes its OWN
   activation-health row locally (independent of the fan-out). The pool detector compares BOTH
   the live `GET /guards?scope=pool` fan-out AND the replicated/self-reported health rows; a peer
   with NO reachable health is **"unknown"** (its own dedup'd attention item), NOT silently
   "dark" — so a broken fan-out/discovery can't mask a real split.

This converges the design: the dev-flag drift, replication drift, rolling-deploy gap, boot race,
and the detector's own failure mode are each addressed. Ready for a final convergence pass +
approval, then the /instar-dev build.

## Round-4 fold (codex r3, MINOR — converged)

1. **Honest framing: the predicate is LOCAL; correctness comes from the LAYERED defense.**
   `replication.enabled === true` is read per-machine — it is NOT assumed magically
   pool-consistent. Correctness is the COMBINATION: (a) local activation on the replication
   signal converges the common case (every replication-on machine activates), (b) the
   capability-refuse guard fail-closes the rolling-deploy / drift window (a transfer to a peer
   not freshly-active is refused, never half-moved), and (c) the split-active detector surfaces
   any residual inconsistency. No single layer assumes config parity.
2. **Capability-refuse checks EPOCH freshness, not just liveness.** A target can be
   `durableOwnershipActive` yet BEHIND the placement journal. `/pool/transfer` refuses (or
   briefly waits) unless the target's advertised `lastAppliedPlacementEpoch` is ≥ the source's
   current ownership epoch for the topic — so a transfer never lands on a peer that hasn't
   caught up to the ownership it's about to receive. (Reuses the §7.4 `seatMoved:false` honesty
   surface with reason `target-behind-epoch`.)

**Converged.** Verdict trajectory SERIOUS→MINOR→MINOR→MINOR; the residual findings are
hardening refinements (capability-refuse semantics, framing), all folded. The CORE fix (the
activation predicate) is stable, built, and unit-tested. Build order: (PR1) the predicate
[done in code] + tests = the bar; (PR2) the capability-refuse guard + heartbeat fields; (PR3)
the split-active detector + the testable lint.

## Open questions

*(none)*
