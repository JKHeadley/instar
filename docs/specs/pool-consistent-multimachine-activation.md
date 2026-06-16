---
title: "Pool-Consistent Activation for Multi-Machine Dev-Gated Features"
slug: "pool-consistent-multimachine-activation"
author: "echo"
parent-principle: "No Silent Degradation to Brittle Fallback"
eli16-overview: "pool-consistent-multimachine-activation.eli16.md"
---

# Spec: Pool-Consistent Activation for Multi-Machine Dev-Gated Features

**Status:** draft (pre-convergence)
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

- **D1 — activation signal.** DECIDED: gate on the coherence-journal placement-replication
  being active (the durable store's real, already-pool-consistent dependency), OR dev.
  _Reversibility: cheap — a one-expression activation-gate change; reversible to the
  per-machine dev-gate; no external side-effect._
- **D2 — backstop strength.** DECIDED: signal-only split-active detector first (an
  Attention item + log row), no auto-disable. _Reversibility: cheap — observe-only._
- **D3 — generalization.** DECIDED: doc the convention + add the CI lint for new
  `multiMachine.*` dev-gated features. _Reversibility: cheap — docs + a lint._

## Open questions

*(none)*
