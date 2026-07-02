---
title: "U4.4 — Lease Hand-Back to the Preferred Captain (reconciler for the F4 preference; claim-before-release; human always wins)"
slug: "u4-4-lease-handback"
author: "echo"
status: "draft"
parent-principle: "The User Experience Is the Product"
sibling-principles: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions; Cross-Store Coherence Is an Invariant; Bounded Blast Radius; Runtime End-to-End Proof; No Unbounded Loops"
parent-fit: "State Convergence sub-standard: a declarative desired-state the system records (here: the operator's preferred captain, F4's preferredAwakeMachineId) must have an owning reconciler that drives actual→desired. Today the preference only SUPPRESSES standby acquisition; nothing hands the lease back after a failover — this spec is that missing reconciler."
parent-spec: "docs/specs/U4-mesh-self-healing-index.md; multi-transport-mesh-comms.md (soloCaptainHold); MULTI-MACHINE-SESSION-POOL-SPEC.md"
project: "self-healing-mesh (topic 29836)"
depends-on: "F4 preferredAwakeMachineId (multiMachine.leaseSelfHeal.preferredAwakeMachineId — the EXISTING preferred-captain authority; per-machine config read by shouldDeferToPreferred, soloCaptainHold eligibility, and the churn latch); FencedLease (epoch CAS, released tombstone, isStampCurrent staleness); churnBreaker (leaseSelfHeal.churnDetector — hand-back flips MUST feed it); lease pull loop (~5s tick, the free health-observation carrier); U4.3 rope-health snapshot (the reachability source); pollFollowsLease (B1 — HARD graduation dependency, see §5); delivery canary (post-hand-back verification)"
---

# U4.4 — Lease Hand-Back to the Preferred Captain

## 1. Problem — corrected by round-1 review

After a failover moves the serving lease off the preferred captain to a standby, the
lease does NOT hand back when the preferred captain recovers. Verified in code: F4's
`preferredAwakeMachineId` only makes a standby DEFER acquisition while the preferred
holder is healthy — nothing releases a non-preferred HOLDER (the lease tick holds
sticky). On the operator's asymmetric setup (always-on Mini + sleep-prone Laptop) the
mesh drifts to the wrong long-term holder until a human runs the manual captain-flip
playbook.

**Round-1 grounding corrections baked into this rewrite:**
- A preferred-captain concept **already exists** (F4). Round 0 proposed a second,
  replicated `preferredHolder` — rejected: it would be (a) a **second divergable
  authority** the deference/soloCaptainHold/churn-latch machinery doesn't read
  (Cross-Store Coherence violation by construction), and (b) an **unsigned field in
  replicated lease state** — a peer-forgeable authority-redirect (the lease signature
  canonicalizes holder/epoch/times/nonce only). This spec is the RECONCILER for the
  EXISTING F4 field; no new preference store.
- Round 0's "standby releases, preferred claims" ordering can strand **zero holders**
  (release lands, claim never does → nobody polls Telegram → the exact silent-loss
  class this project exists to kill, caused by the healer). Fixed: claim-before-release.
- Round 0 had no operator-override, no episode bound (a ~15-min ping-pong slips under
  the churn breaker's 4-flips-per-600s window), and silently assumed ingress follows
  the lease (pollFollowsLease is dry-run on the fleet today).

## 2. Design

**A hysteresis-gated reconciler, running in the lease tick, that drives the lease
toward the F4-preferred captain — with the human always winning.**

- **Authority: F4's `multiMachine.leaseSelfHeal.preferredAwakeMachineId`, unchanged.**
  Per-machine operator config (machines agree by being configured consistently — the
  existing F4 agreement model; `GET /pool` surfaces each machine's view so
  disagreement is visible). NOT replicated, NOT in the lease record, NEVER writable
  by a peer. Unset = today's sticky behavior (strict no-op).
- **Observation rides the existing ~5s lease pull tick** — no new dial loop. The
  HOLDER (only) evaluates: preferred-captain health = heartbeat-fresh AND reachable
  on ≥1 rope (the U4.3 rope-health snapshot is the source; pre-U4.3 the passive
  per-tick dial results serve) AND lease-eligible AND quota-OK. Deep-serving health
  (can it renew lease state?) is implied by heartbeat freshness — stated, not
  assumed.
- **Hysteresis:** hand-back arms only after the preferred captain is continuously
  healthy for `handbackHealthWindowMs` (default 10 min). Any unhealthy observation
  resets the window. Window state is in-memory on the holder; a holder restart resets
  it (declared: safe direction — defers, never rushes).
- **Clean boundary, bounded deferral:** the armed hand-back fires at a clean boundary
  (no in-flight forwards, no queued inbound, no ingress in the last ~90s — the
  server-side signals, MIRRORING the lifeline drift-promoter's predicate shape; it is
  new server-side code, not cross-process reuse). A busy standby defers — but not
  forever (P19): after `handbackDeferralCeilingMs` (default 2h) of continuous
  deferral, ONE deduped notice surfaces ("hand-back to <nickname> has been waiting
  Nh for a quiet moment") and the boundary criteria relax to "no in-flight forward"
  only at the next tick. Deferral count is metered.
- **Transfer ordering — claim-before-release (the zero-holder fix).** The holder
  sends a `handback-offer` mesh RPC to the preferred captain; the preferred captain
  CLAIMS with a bumped fenced epoch (the normal CAS); the old holder observes the
  higher epoch and steps down (its stamps go stale by the existing `isStampCurrent`
  check — no double-serve window by the same fencing that guards every transfer).
  If the claim never lands, the holder KEEPS HOLDING — a failed hand-back can never
  leave zero holders. Test: `failed-handback-never-leaves-zero-holders`.
- **Post-hand-back verification (Runtime End-to-End Proof):** after the transfer, the
  new holder runs one delivery-canary round-trip; failure raises ONE loud escalation
  (attention item) — never silent.
- **The human always wins (operator-flip latch).** An operator-initiated lease move
  (the manual flip playbook, a future explicit route, or any transfer whose origin is
  operator-attributed) writes a machine-local `handbackSuppressedUntil` marker
  (default TTL 24h, config `handbackOperatorLatchMs`; clearable early by config edit
  or re-flip). While latched, the reconciler is fully inert and says so in its
  status. The automation never fights a deliberate human move.
- **Flap/episode bounds (beyond hysteresis):** (a) hand-back transfers COUNT as flips
  for the existing `leaseSelfHeal.churnDetector`, and a LATCHED churn breaker
  suppresses hand-back (the two compose: breaker wins). (b) Own episode cap: at most
  `handbackMaxPerWindow` (default 2) hand-backs per rolling 6h; at the cap the
  reconciler goes sticky and raises ONE deduped attention item naming the ping-pong
  (the slow-oscillation shape that slips under the churn window). 
- **Split-brain:** hand-back is suppressed while `splitBrainState` is active (signal
  already in syncStatus) — reconciliation waits for a settled mesh.
- **Composes with soloCaptainHold:** hold covers preferred-is-GONE; hand-back covers
  preferred-is-BACK-and-stable. Both key on the SAME F4 field (that is the point).
  Under the fleet's real posture (soloCaptainHold dark), hand-back still works — it
  needs only the F4 field and the fenced lease.
- **>2 machines:** the `handback-offer` is directed AT the preferred captain (it
  claims with the bumped epoch before any other standby can — the offer→claim path is
  first-mover); if a third machine races the CAS and wins, the reconciler simply
  re-evaluates next tick (converges toward preferred; bounded by the episode cap).

## 3. Multi-machine posture (mandatory)

Inherently multi-machine. Preference: per-machine F4 config (existing model; NOT
replicated — reach is not authority). Hysteresis/deferral/latch state: machine-local
in-memory + the latch marker on disk (machine-local by design). Decision-maker: the
current HOLDER only (one decider). Single-machine: strict no-op. Ingress: see the
pollFollowsLease dependency (§5) — the lease moving without ingress moving is a
lease/ingress split, the exact class this project eliminates, so hand-back REFUSES to
arm unless pollFollowsLease is live (or the install has no poller split).

## 4. Observability (half-metered funnels forbidden)

Feature-metrics key `lease-handback`: window-starts, window-resets (flap evidence),
armed, deferrals, ceiling-relaxations, offers, claims, step-downs, failures,
canary-verify results, suppressed-by-latch, suppressed-by-churn, episode-cap trips,
dry-run would-hand-back. `GET /pool` placement view names the last hand-back episode
and the latch state ("hand-back suppressed until <t> — operator flip").

## 5. Config, rollout, migration

- **Config (real subtree — sibling of soloCaptainHold):**
  `multiMachine.leaseSelfHeal.preferredCaptainHandback` = `{ enabled, dryRun,
  healthWindowMs: 600000, deferralCeilingMs: 7200000, operatorLatchMs: 86400000,
  maxPerWindow: 2, windowMs: 21600000 }`. (Round 0's
  `multiMachine.meshTransport.leaseSelfHeal.*` path was WRONG — no such subtree.)
- **Rollout — the action-bearing lease-authority posture (documented Maturation-Path
  exception):** like its siblings F2/F3/L3 (staleHolderTakeover,
  silentStandbyRelinquish, soloCaptainHold), this feature moves REAL serving
  authority, so it ships in `DEV_GATED_FEATURES`' action-bearing category:
  **dark everywhere including dev until the live two-machine pair verification
  passes**, then live-on-dev in dryRun (logging would-hand-back), then
  `dryRun:false` on dev, then fleet. Graduation criteria (named): ≥1 live verified
  hand-back on the Mini+Laptop pair (fail over to Laptop, heal Mini, watch the
  hand-back fire at a clean boundary, canary-verify ingress on the Mini) + 7 days
  with zero episode-cap trips. guardManifest entry with `loadBearing: true`,
  `criticalPath: "serving-lease returns to intended captain"`; interim manual
  fallback = the captain-flip playbook, recorded as the operator-accepted fallback.
- **HARD dependency (declared):** `pollFollowsLease` (B1) must be live before
  `preferredCaptainHandback` may leave dryRun — otherwise hand-back moves the lease
  while the Laptop keeps polling Telegram (lease/ingress split). Enforced at the
  enable chokepoint: `dryRun:false` with pollFollowsLease still dry-run is REFUSED
  loudly at boot (config validation), not silently accepted.
- **Migration parity:** config defaults via `migrateConfig`; CLAUDE.md template
  proactive trigger ("why did serving move back to the Mini by itself?" → the
  hand-back reconciler; `GET /pool` names the episode) via `migrateClaudeMd`.
- **Rollback:** `enabled:false` (or unset F4 preference) → sticky lease, today's
  behavior; the latch marker is inert data.

## 6. Tests (tiers declared)

Unit: hysteresis window arm/reset; clean-boundary predicate (each signal); deferral
ceiling → relax + ONE notice; claim-before-release ordering (failed claim ⇒ holder
retains — zero-holder impossibility); operator-latch suppresses; churn-latch
suppresses; episode cap → sticky + ONE item; split-brain suppresses; >2-machine race
converges; config validation refuses dryRun:false without pollFollowsLease live.
Integration: metrics rows through the real pipeline; `GET /pool` surfaces latch +
episode. E2E lifecycle (feature-alive): production init with the feature dev-enabled
→ reconciler ticking (dry-run counters advance under a synthetic preferred-unhealthy→
healthy transition); dark → zero presence. Wiring-integrity: the reconciler is
constructed by real server boot and reads the SAME F4 config field
`shouldDeferToPreferred` reads (one authority — assert by reference, not string
equality). Live two-machine drive (mandatory before dryRun:false, per the
multi-transport live-verify posture): the graduation scenario above, plus
`handback-and-soloCaptainHold-compose` exercised live on the dev pair.

## Frontloaded Decisions

1. **F4's `preferredAwakeMachineId` is THE preference authority** — no new field, no
   replication, nothing in the signed lease record. This spec is F4's missing
   reconciler (State Convergence). Cross-machine agreement stays the F4 model
   (consistent per-machine config, disagreement visible on `GET /pool`).
2. **Claim-before-release** — the preferred captain claims with a bumped fenced
   epoch; the old holder steps down on observing it; a failed claim leaves the holder
   holding. Zero-holder states are impossible by construction.
3. **The human always wins** — any operator-attributed lease move latches the
   reconciler off for 24h (configurable), and the latch state is loudly visible.
4. **Bounded everywhere (P19):** hysteresis (10 min) + deferral ceiling (2h → relax +
   notice) + episode cap (2 per 6h → sticky + ONE item) + churn-breaker composition
   (hand-backs count as flips; a latched breaker wins).
5. **pollFollowsLease is a HARD graduation dependency** — enforced at the enable
   chokepoint, refused loudly, never assumed.
6. **Post-hand-back canary verification** — a transfer is not done until ingress is
   proven on the new holder; failure escalates loudly.
7. **Action-bearing rollout posture** (documented Maturation-Path exception,
   matching F2/F3/L3): dark until the live-pair drive passes, then dev dry-run →
   dev live → fleet; G3 loadBearing registration with the playbook as the recorded
   interim fallback.
8. **Default unset = today's sticky behavior** — opt-in per operator setup.
9. **Window/latch state is in-memory/machine-local and resets on restart** —
   declared; the fail direction is deferral, never a rushed transfer.

## Open questions

None.
