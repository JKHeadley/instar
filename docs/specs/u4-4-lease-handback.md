---
title: "U4.4 — Lease Hand-Back to the Preferred Captain (reconciler for the F4 preference; claim-before-release; human always wins)"
slug: "u4-4-lease-handback"
author: "echo"
status: "draft"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
sibling-principles: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions; Cross-Store Coherence Is an Invariant; Bounded Blast Radius; Runtime End-to-End Proof; No Unbounded Loops"
parent-fit: "State Convergence sub-standard: a declarative desired-state the system records (here: the operator's preferred captain, F4's preferredAwakeMachineId) must have an owning reconciler that drives actual→desired. Today the preference only SUPPRESSES standby acquisition; nothing hands the lease back after a failover — this spec is that missing reconciler."
parent-spec: "docs/specs/U4-mesh-self-healing-index.md; multi-transport-mesh-comms.md (soloCaptainHold); MULTI-MACHINE-SESSION-POOL-SPEC.md"
project: "self-healing-mesh (topic 29836)"
depends-on: "F4 preferredAwakeMachineId (multiMachine.leaseSelfHeal.preferredAwakeMachineId — the EXISTING preferred-captain authority; per-machine config read by shouldDeferToPreferred, soloCaptainHold eligibility, and the churn latch); FencedLease (epoch CAS, released tombstone, isStampCurrent staleness; canAcquire's held-by-live-peer refusal is the state the R-r2-1 consent branch opens); churnBreaker (leaseSelfHeal.churnDetector — hand-back flips MUST feed it); lease pull loop (~5s tick, the free health-observation carrier); U4.3 rope-health snapshot (the reachability source — HARD build-order dependency, R-r2-7: the resolver is process-private pre-U4.3, so no health source exists before the snapshot seam); pollFollowsLease (B1 — HARD graduation dependency, see §5); delivery canary (post-hand-back verification)"
review-convergence: "2026-07-02T07:29:45.416Z"
review-iterations: 3
review-completed-at: "2026-07-02T07:29:45.416Z"
review-report: "docs/specs/reports/u4-4-lease-handback-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 0
contested-then-cleared: 2
approved: true
approved-basis: "Operator preapproval for spec approvals in this session (topic 29836, 2026-07-02): 'Full preapproval granted … spec approvals, server restarts, deployment, and all in-scope reversible decisions.' Recorded transparently, not silently self-granted."
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
  on ≥1 rope (the U4.3 rope-health snapshot is the source) AND lease-eligible AND
  quota-OK. **U4.3 is a declared build-order dependency for the health source
  (R-r2-7):** round 1's "pre-U4.3 the passive per-tick dial results serve" clause
  is DROPPED — those passive results only become readable through the U4.3
  snapshot seam (the resolver is process-private today), so there is no pre-U4.3
  health source; U4.3 merges first. An **absent snapshot record** for the
  preferred captain (never dialed, or evicted) reads as **not-healthy → defer** —
  the reconciler fails toward holding, never toward a transfer on missing data.
  Note: the U4.3 hedge-abort transport fix (u4-3 R-r2-1) also benefits this spec —
  without it, a healthy sibling rope's hedge win spuriously resets the preferred
  captain's rope health and with it this reconciler's continuity window.
  Deep-serving health (can it renew lease state?) is implied by heartbeat
  freshness — stated, not assumed.
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
  only at the next tick. **The relaxed boundary must not strand queued inbound
  (R-r2-6):** before stepping down at the relaxed boundary, queued/held items on
  the old holder are drained or re-routed via the EXISTING durable inbound-queue
  semantics (`multiMachine.sessionPool.inboundQueue`,
  `docs/specs/durable-inbound-message-queue.md` — the same queue that already
  handles a mid-move conversation) — never abandoned on the old holder. Deferral
  count is metered.
- **Transfer ordering — claim-before-release (the zero-holder fix), via a
  consent-authorized acquisition branch (R-r2-1).** Round 1's "claims with a
  bumped fenced epoch (the normal CAS)" is NOT buildable: `FencedLease.canAcquire`
  returns `held-by-live-peer` for a live, healthy holder — which is EXACTLY the
  hand-back state (the holder is alive and consenting, not stale). The claim
  therefore needs a NEW consent-authorized acquisition branch: the
  `handback-offer` carries a **SIGNED, epoch-bound, TTL-bounded, SINGLE-USE holder
  consent token** (signed by the holder's machine key; bound to the holder's
  current epoch, the offered target machine, and an expiry), and the preferred
  captain presents it at acquire time via a `handbackOpts` analogue of the
  existing `StaleHolderTakeoverOpts` seam. `canAcquire` grants ONLY when the token
  verifies, names this claimant, matches the live lease's holder + epoch, is
  unexpired, and is unused — **fail-closed default**: absent/invalid/expired/
  reused token ⇒ today's `held-by-live-peer` refusal, unchanged. Tests required
  for expiry, replay, and reuse (each refused). The old holder observes the higher
  epoch and steps down (its stamps go stale by the existing `isStampCurrent`
  check — no double-serve window by the same fencing that guards every transfer).
  If the claim never lands, the holder KEEPS HOLDING — a failed hand-back can never
  leave zero holders. Test: `failed-handback-never-leaves-zero-holders`.
- **`handback-offer` RPC contract (R-r2-2).** A new `MeshCommand` union entry:
  `{ type: 'handback-offer'; proposedEpoch; consentToken; expiresAt }`. RBAC
  (`checkCommandRBAC`, its own case, default-deny): only the **CURRENT lease
  holder** may send it — verified against the live lease, mirroring the
  drain-verb's role-checked posture. Typed responses: `accept` /
  `declined:churn-latched` / `declined:quota` / `declined:legacy-peer`; on
  timeout or silence the holder KEEPS HOLDING. Nonce/idempotency rides the
  standard envelope replay guard AND the single-use consent token — a replayed
  offer never re-authorizes a second claim. **Version skew:** an old peer without
  the verb fails the RBAC/handler path closed (a `claim-unauthorized`-class 403 /
  `no-handler` refusal); the sender classifies that as **peer-cannot-hand-back
  and STOPS re-offering** for the episode (mirroring the drain-verb skew-posture
  convention: degrade to today's sticky behavior, never hammer an old peer).
- **Refused/failed offers must not loop (R-r2-3).** The holder side keeps a
  per-target offer backoff (a declined/timed-out offer widens the retry interval),
  offers are metered (feature-metrics `offers` vs `claims`), and the episode cap
  below counts **OFFERS as well as completed hand-backs** — a peer that keeps
  declining consumes the episode budget and trips the same sticky-plus-ONE-item
  brake, never an unbounded offer stream.
- **Post-hand-back verification (Runtime End-to-End Proof):** after the transfer, the
  new holder runs one delivery-canary round-trip; failure raises ONE loud escalation
  (attention item) — never silent.
- **The human always wins (operator-flip latch) — with a MECHANICAL attribution
  definition (R-r2-5).** "Operator-attributed" is not an inference: the latch is
  **WRITTEN BY the explicit flip action itself**. Concretely: a PIN-gated flip
  route (the productized captain-flip lever) writes the machine-local
  `handbackSuppressedUntil` marker as part of executing the flip; until that route
  ships, the manual captain-flip playbook gains an explicit step that POSTs the
  latch marker. The reconciler **never infers attribution from a transfer's
  origin** — a lease move without the marker is just a lease move (the reconciler
  may hand it back), and a move WITH the marker is latched (default TTL 24h,
  config `handbackOperatorLatchMs`; clearable early by config edit or re-flip).
  While latched, the reconciler is fully inert and says so in its status. The
  automation never fights a deliberate human move.
- **Flap/episode bounds (beyond hysteresis):** (a) hand-back transfers COUNT as flips
  for the existing `leaseSelfHeal.churnDetector`, and a LATCHED churn breaker
  suppresses hand-back (the two compose: breaker wins). (b) Own episode cap: at most
  `handbackMaxPerWindow` (default 2) hand-back EPISODES per rolling 6h — and the
  cap counts **offers sent as well as completed hand-backs** (R-r2-3), so a
  declining/failing peer consumes the budget too; at the cap the reconciler goes
  sticky and raises ONE deduped attention item naming the ping-pong (the
  slow-oscillation shape that slips under the churn window). 
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
  exception), in the RIGHT registry (R-r2-4):** like its siblings F2/F3/L3
  (staleHolderTakeover, silentStandbyRelinquish, soloCaptainHold), this feature
  moves REAL serving authority, so it ships as a **`DARK_GATE_EXCLUSIONS` entry
  (`src/core/devGatedFeatures.ts:513` — where F2/F3/L3's action-bearing rows
  live), category `'action-bearing'`, `enabled: false` default**. Round 1 named
  `DEV_GATED_FEATURES` — WRONG registry: that is the live-on-dev list, and a
  builder following it would ship this live on dev agents, INVERTING the mandated
  hard-dark posture. Corrected posture: **dark everywhere including dev until the
  live two-machine pair verification passes**, then live-on-dev in dryRun (logging
  would-hand-back), then `dryRun:false` on dev, then fleet. Graduation criteria
  (named): ≥1 live verified hand-back on the Mini+Laptop pair (fail over to
  Laptop, heal Mini, watch the hand-back fire at a clean boundary, canary-verify
  ingress on the Mini) + 7 days with zero episode-cap trips. guardManifest entry
  with `loadBearing: true`, `criticalPath: "serving-lease returns to intended
  captain"` — declaring `soakWindowDays` + `declaredLoadBearingAt` so the
  pre-graduation dark/dry-run posture classifies `loadBearingSoaking` within its
  window (R-r2-7), OR (since the feature is deliberately hard-dark past any
  reasonable soak) a named operator-accept recorded via the G3 accept mechanism
  at day one; interim manual fallback = the captain-flip playbook, recorded as
  that operator-accepted fallback.
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
ceiling → relax + ONE notice + queued/held inbound drained or re-routed before
step-down (never abandoned — R-r2-6); claim-before-release ordering (failed claim ⇒
holder retains — zero-holder impossibility); **consent-token acquisition branch
(R-r2-1):** valid token ⇒ grant; absent/invalid/**expired**/**replayed**/**reused**
token ⇒ `held-by-live-peer` refusal unchanged (fail-closed, each case);
**`handback-offer` RBAC (R-r2-2):** non-holder sender denied (default-deny), each
typed decline handled, timeout ⇒ holder keeps holding, replayed offer never
re-authorizes, legacy-peer refusal ⇒ sender stops re-offering for the episode;
offer backoff widens on decline/timeout (R-r2-3); operator-latch suppresses AND is
only ever written by the flip action (a transfer without the marker never latches
— R-r2-5); churn-latch suppresses; episode cap (counting offers too) → sticky +
ONE item; absent snapshot record ⇒ not-healthy/defer (R-r2-7); split-brain
suppresses; >2-machine race converges; config validation refuses dryRun:false
without pollFollowsLease live.
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
2. **Claim-before-release, via the consent-authorized acquisition branch (R-r2-1,
   R-r2-2)** — `canAcquire`'s `held-by-live-peer` refusal is EXACTLY the hand-back
   state, so the preferred captain claims by presenting the holder's signed,
   epoch-bound, TTL-bounded, single-use consent token (a `handbackOpts` analogue
   of `StaleHolderTakeoverOpts`; fail-closed default). The offer is a new
   `MeshCommand` verb, holder-only RBAC, typed declines, replay-proof; the old
   holder steps down on observing the higher epoch; a failed/silent claim leaves
   the holder holding. Zero-holder states are impossible by construction; a
   legacy peer fails closed and the sender stops re-offering.
3. **The human always wins** — the latch is written BY the explicit flip action
   itself (PIN-gated route / playbook POST step), never inferred from transfer
   origin (R-r2-5); it holds the reconciler off for 24h (configurable), and the
   latch state is loudly visible.
4. **Bounded everywhere (P19):** hysteresis (10 min) + deferral ceiling (2h → relax +
   notice, with queued inbound drained/re-routed before step-down — R-r2-6) +
   episode cap (2 per 6h, offers counted too — R-r2-3 → sticky + ONE item) +
   holder-side offer backoff + churn-breaker composition (hand-backs count as
   flips; a latched breaker wins).
5. **pollFollowsLease is a HARD graduation dependency** — enforced at the enable
   chokepoint, refused loudly, never assumed.
6. **Post-hand-back canary verification** — a transfer is not done until ingress is
   proven on the new holder; failure escalates loudly.
7. **Action-bearing rollout posture, in `DARK_GATE_EXCLUSIONS` (R-r2-4)**
   (documented Maturation-Path exception, matching F2/F3/L3 — the action-bearing
   category at `devGatedFeatures.ts:513`, `enabled:false` default; NOT the
   live-on-dev `DEV_GATED_FEATURES` registry round 1 misnamed): dark until the
   live-pair drive passes, then dev dry-run → dev live → fleet; G3 loadBearing
   registration (soak constants or day-one operator-accept — R-r2-7) with the
   playbook as the recorded interim fallback.
8. **Default unset = today's sticky behavior** — opt-in per operator setup.
9. **Window/latch state is in-memory/machine-local and resets on restart** —
   declared; the fail direction is deferral, never a rushed transfer.

## Open questions

None.
