---
title: "U4.2 — Stale-Owner Release: the CMT-1786 auto-failover, built as the evidence upgrade to OwnershipReconciler Case C"
slug: "u4-2-stale-owner-release"
author: "echo"
status: "draft"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
sibling-principles: "The Agent Is Always Reachable; Verify the State, Not Its Symbol; A Refusal Stays a Refusal; Bounded Blast Radius; A Dark Feature Guards Nothing"
lessons-engaged: "stranded-inbound-self-heal.md §Deferred-v2 (CMT-1786, all seven prerequisites walked in §2.7); P19 (bounded loops); P20 (verify the state); P17 (one deduped item); mesh-lease-tick-wedge-rootcause (local memory, topic 27515); Live-User-Channel Proof Before Done"
parent-spec: "docs/specs/U4-mesh-self-healing-index.md; docs/specs/stranded-inbound-self-heal.md; MULTI-MACHINE-SESSION-POOL-SPEC.md; MULTI-MACHINE-SEAMLESSNESS-SPEC.md"
project: "self-healing-mesh (topic 29836)"
depends-on: "OwnershipReconciler (WS1.3 Case C force-claim — the machinery this EXTENDS); SessionOwnership FSM (ownershipEpoch fence, applyOwnershipAction); StrandedTopicSentinel (detection layer, loadBearing); fenced serving lease (the claim ARBITER); multiMachine.meshTransport (authenticated probes); WorkingSetPullCoordinator; MessageProcessingLedger; U4.1 (pin suspend interaction)"
---

# U4.2 — Stale-Owner Release Path

## 1. Problem — two distinct strands, honestly separated

**The gap this spec closes:** when a topic's OWNER machine is genuinely dead or dark
(powered off, crashed, fully partitioned), its topics are STRANDED: the ownership
record still points at the dark machine and no peer may serve them. The existing
machinery deliberately stops short: `OwnershipReconciler` Case C force-claims only
PINNED topics with death evidence + quorum; `StrandedTopicSentinel` (loadBearing,
detection-only) tells the operator, because the prior converged spec
`stranded-inbound-self-heal.md` ruled auto-failover unsafe without seven named
prerequisites and deferred it as **CMT-1786**. U4.2 IS that deferred v2, with the
prerequisites now satisfiable (§2.7).

**What this spec does NOT claim to fix:** the 2026-06-23 lease-tick wedge
(topic 27515, `mesh-lease-tick-wedge-rootcause`) — there the owner was ALIVE and
locally healthy; a flaky peer wedged the holder's lease tick and the liveness
reconciler self-fenced on `holdsLease:false`. That shape was fixed at the lease-wire
layer (`multi-transport-mesh-comms`); U4.2's claim bar (owner provably gone) would
correctly NOT fire in it. Citing it here as motivation was wrong in the draft and is
withdrawn; the dark-owner strand is a distinct, still-open gap.

## 2. Design — extend Case C; one takeover authority; the epoch is the fence

### 2.1 One authority, one fence

U4.2 is implemented AS the ownership FSM's existing `force-claim` action
(`applyOwnershipAction` on the `SessionOwnershipRecord`), driven by
`OwnershipReconciler` Case C with an upgraded evidence bar and coverage extended to
UNPINNED topics. `ownershipEpoch` IS the fence — no parallel `fenceToken` field, no
new record kind, no second store (Cross-Store Coherence: the existing record keeps
answering "who owns this topic"). Claims respect the FSM's `transferring` /
`drainInFlight` / claim-grace semantics — a mid-drain death rides the existing
recovery, never a raw CAS over it.

**Arbiter:** only the serving-lease HOLDER runs stale-owner claims (single claimer
by construction — matches the MeshRpc RBAC posture where failover claim/release is
router-only). This answers the substrate honestly: the shipped ownership CAS is
per-machine (`LocalSessionOwnershipStore`) with journal convergence, so "only one
peer wins" must come from claimer-uniqueness, not from a cross-machine CAS that does
not exist. Two-machine degenerate case: the surviving machine holds the serving
lease (or takes it via the existing lease failover first), then claims.

### 2.2 The evidence bar (ALL required; fail CLOSED on any ambiguity)

1. **Machine death evidence** (existing Case C bar): owner offline in the pool
   registry AND observer-stamped `lastSeen` ≥ `deathEvidenceMs`. There is **no
   per-topic heartbeat** — per-topic staleness derives from the owner MACHINE's one
   capacity heartbeat (HTTP path, works git-less); per-topic records are written
   only on claim/release transitions (no write amplification; the L0 no-git-for-
   heartbeats rule holds). Clock model: staleness is measured on the OBSERVER's
   monotonic clock from the last VERIFIED heartbeat fold-in (the FencedLease-F2
   pattern); a record/machine never observed heartbeating is NOT-expired (fail
   closed — protects pre-U4.2 owners under version skew).
2. **Multi-transport disproof:** the owner is unreachable via the authenticated
   signed-handshake probe on EVERY advertised transport. The advertisement set must
   be non-empty AND freshness-bounded (older than N heartbeats = ambiguity); a
   single-transport advertisement is automatic ambiguity (the single-rope false-death
   is the exact bug to avoid — surfaced as a U4.5 rope-health line, not claimed
   around). ONE reachability verdict per (owner, episode) — single-flight,
   TTL-memoized, backoff between episodes, shared by all that owner's topics; probe
   timeout well below the lease transport's 30s.
3. **Quorum** (verbatim Case C): the claimant observes a majority partition
   (`online × 2 > machines`). Two-machine degenerate: rule 2.1's lease-holder
   arbitration + the self-connectivity proof below stand in.
4. **Claimant self-connectivity proof:** the claimant proves its OWN network is
   healthy within the same window (a successful authenticated probe of a third peer,
   or in the 2-machine case a verified reach of the durable lease authority) —
   a claimer with a broken NIC sees everyone as dead and must never claim.
5. **Owner liveness disproof (not just unreachability):** the owner's last
   AUTHENTICATED side-effect (journal write, ownership/lease renewal, ledger row)
   is older than the bound. Mesh-unreachable ≠ dead: a machine can lose every
   peer-to-peer rope yet still reach api.telegram.org and keep replying.
6. **Fresh CAS-authority access + re-read immediately before the claim.**

### 2.3 The other half: the owner fences ITSELF

- **Self-fence (local, no connectivity needed):** an owner that cannot renew its
  ownership/serving participation within TTL stops emitting for its topics — so
  "expired" implies "self-fenced" by construction, closing the outbound-alive
  double-reply path.
- **Emission fence wiring is a graduation dependency:** the §L3 output-exclusion
  contract (`mayEmit`/`isStampCurrent`) and `FencedOutbox` currently have ZERO
  production callsites, and `MessageProcessingLedger.replyEpoch` is stored but never
  enforced at a send chokepoint. Wiring the epoch-stamped send check at the Telegram
  relay chokepoint is an explicit prerequisite for this feature leaving dry-run —
  "its stale fence loses every write" must include user-visible sends, or it is a
  symbol, not the state.
- **Returning-owner teardown:** on observing fence loss (boot re-verification of
  ownership against the replicated registry BEFORE any respawn), the returned owner
  reaps its local session (reap-log reason `topic claimed by <machine>`), suspends
  its autonomous-run state under the existing moved-topic markers, clears the
  topic's resume UUID, and refuses ingress for the topic. Test:
  `returned-owner-does-not-respawn-claimed-run`.

### 2.4 Claim-time semantics (the three hard runtime moments)

- **Pins (U4.1 interaction):** a stale-owner claim SUSPENDS the topic's pin
  (`pin-held-pending-owner-return`) rather than leaving pin↔owner divergence for the
  reconciler to fight — no claim/transfer-back oscillation. Pin resumption follows
  U4.1's sustained-online hysteresis when the owner returns. Local pins in the
  reconciler's cooperative path gain the same online-gate the advisory pins already
  have (named code fix).
- **In-flight messages:** the claim performs an inbound-queue reconciliation:
  redeliver only rows not known reply-committed. Delivery across a claim is
  **at-least-once by design in v1** (the reply-committed watermark is machine-local
  SQLite; the duplicate-send suppression layers mitigate). Replicating the
  reply-committed watermark is increment E (in scope, dark), upgrading claim-time
  redelivery toward exactly-once.
- **Working set:** attempt the pull; against a provably-dark producer it queues
  durably (existing carrier semantics) and the claimed topic RESUMES from
  last-synced state with the honest continuation disclosure ("picking this back up
  from the other machine — as of last sync"). Test:
  `working-set-pull-queued-and-resume-proceeds`. On owner return, queued pulls drain
  staggered (existing single-file drain).

### 2.5 Bounded blast radius (P19)

`maxClaimsPerTick` cap; post-claim session resumption routes through the EXISTING
paced resume queue (one at a time, calm+quota gated) — never a mass spawn (the
2026-06-20/26 resource-panic shape); per-topic claim budget with widening backoff
and a LOUD P19 give-up (one attention item — the resurrection-cap mirror); probe
cadence carries backoff + a breaker that degrades to the attention item.

### 2.6 Honesty surfaces (a refusal stays a refusal)

- **Durable decision trace:** every stale-detect, probe verdict, would-claim
  (dry-run), claim, and REFUSAL lands in `logs/stale-owner-release.jsonl` on the
  deciding machine — a no-claim verdict leaves an artifact, never silence. Dry-run
  logging is state-change-gated per episode (first observation / verdict change /
  would-claim once per topic per episode — the transport first/Nth/recovery
  precedent), never per-tick.
- **Bounded ambiguity:** ambiguity persisting past ~3× TTL escalates into the SAME
  per-episode deduped partition attention item ("topic looks stranded; I can't prove
  the owner's state — your call") — never an indefinite silent strand. Episode
  boundaries: 30 min of calm closes an episode; repeat episodes collapse via the
  OwnerSuspectBreaker flap-accounting pattern (≤ one item per flap episode).
- **A declined demote persists:** the operator's "no" durably pins the topic
  against claim for that episode — conditions drifting does not resurrect the ask.
- **User-facing takeover notice:** the claimed topic gets the existing per-topic
  continuation disclosure (coalesced, durable path) — a conversation never changes
  machines without the user being told once, honestly.

### 2.7 The CMT-1786 prerequisites, walked

1. *Per-topic remote-session-liveness signal* → §2.2.5 (authenticated side-effect
   recency), not mere reachability.
2. *Temporal hysteresis* → §2.2.1 death-evidence bound + §2.5 claim budget/backoff +
   episode calm windows.
3. *Claim-time re-assertion* → §2.2.6 re-read before CAS + §2.1 FSM semantics.
4. *Atomic CAS + pin-repoint transaction boundary* → §2.4 pin-suspend joined to the
   claim action inside the reconciler's single apply path.
5. *Reason-stamped nonce convention* → claims stamp `reason: stale-owner-release`
   + episode id into the ownership action (visible in the decision trace + reap-log).
6. *Structural disjointness from OwnershipReconciler* → resolved by INVERSION:
   U4.2 is not a second actor to keep disjoint — it IS Case C's evidence upgrade;
   one actor, so disjointness is by construction.
7. *Unify-or-prove-disjoint with StrandedTopicSentinel* → unified: the sentinel
   remains the DETECTION + operator-notice layer; its auto-failover v2 pointer now
   resolves to this spec; the reconciler is the sole ACTUATOR. Sentinel keeps firing
   during dry-run (its notice is the operator's view of would-claims).

### 2.8 Supervision declaration

Tier 0 — the claim gate is deterministic by design (no policy decisions on the
critical path; every predicate is a mechanical check over authenticated state).
LLM-free, spawn-cap-neutral (asserted by test, the StrandedTopicSentinel pattern).

## 3. Multi-machine posture (mandatory)

Inherently multi-machine. The ownership record stays the existing replicated L3
state (journal-converged, epoch-fenced); the decision trace is machine-local BY
DESIGN (a verdict is only meaningful from the machine that judged it); reachability
verdicts are per-(claimant, owner, episode), machine-local, TTL-bounded. Version
skew: a pre-U4.2 owner never heartbeats per-topic — and is therefore NOT-expired
(fail closed, §2.2.1) and never probed on a new route (§2.2.2 uses the existing
signed handshake), so an updated peer can never false-claim from an old-version
owner; a claim never lands unless the claimant runs U4.2 (the only writer of the
new evidence). Single-machine install: strict no-op — both the heartbeat-derivation
and claim sides are subordinate to `sessionPool` being live AND ≥2 registered
machines. Rollback tolerance: pre-U4.2 readers ignore unknown fields; a flag dropped
mid-claim leaves the topic owned by the claimant via the normal record (servable).

## 4. Tests (tiers declared)

Unit: `expired-plus-all-transports-plus-quorum-plus-self-proof-allows-claim`;
`owner-reachable-on-one-transport-never-claims`; `transport-ambiguity-fails-closed`;
`empty-or-stale-or-single-advert-set-is-ambiguity`; `claimant-egress-down-never-claims`;
`never-heartbeated-owner-is-not-expired` (version-skew fail-closed);
`forged-heartbeat-from-non-owner-rejected` (freshness binds to authenticated sender);
`concurrent-claims-arbiter-uniqueness` (lease-holder-only);
`stale-owner-return-loses-writes-and-tears-down` (fence + teardown);
`claim-suspends-pin-no-oscillation`; `claims-are-capped-and-paced-per-tick`;
`working-set-pull-queued-and-resume-proceeds`;
`flapping-partition-raises-one-item-not-one-per-flap`; `declined-demote-persists`;
`decision-trace-records-refusals`; `probe-loop-bounded-p19`;
`supervision-tier0-no-spawn-slot`.
Integration: `/pool/placement` reports `ownershipLeaseState: held|stale|releasing|claimed`;
wiring-integrity (reconciler evidence deps non-null + delegating); dry-run
would-claim lines state-change-gated.
E2E (feature-alive): two-registry lifecycle — owner darkened → lease-holder claims →
topic servable → owner returns → teardown, zero double-owner.
Live (Test-as-Self, per Live-User-Channel Proof): kill the owner's server; message
the topic through real Telegram; assert the survivor answers with the continuation
disclosure and the claim trace records the episode; verify zero double-reply.

## 5. Rollback / rollout

Config: `multiMachine.sessionPool.staleOwnerRelease` = `{enabled, dryRun,
deathEvidenceMs, probeTimeoutMs, ambiguityCeilingMultiple, maxClaimsPerTick}` (house
pattern: `inboundQueue`), registered in DEV_GATED_FEATURES (dev-live-in-dryRun →
dev-live → fleet; the omitted-`enabled` dev-gate pattern) and in GUARD_MANIFEST as
`loadBearing: true` (critical path: "topic reachability when its owner dies") so a
stalled dark/dry-run posture classifies loudly per #1318 instead of sitting quiet —
this feature class is literally on the postmortem's existed-but-dark list.
Graduation past dry-run additionally REQUIRES the §2.3 emission-fence wiring.
Agent awareness: CLAUDE.md template gains the proactive trigger ("user asks 'why did
my conversation move machines by itself?' → read the claim trace + placement
ownershipLeaseState") + the matching `migrateClaudeMd` patch. Rollback = drop the
flag; ownership reverts to explicit-transfer-only + sentinel detection (today).

## Frontloaded Decisions

1. **U4.2 IS CMT-1786's v2 auto-failover, built as Case C's evidence upgrade** — one
   takeover authority, `ownershipEpoch` as the only fence, prerequisites walked
   (§2.7). No parallel machinery.
2. **The serving-lease holder is the sole claimer** — claimer-uniqueness by
   construction, honest about the per-machine CAS substrate.
3. **Evidence = death + transport-disproof + quorum + self-proof + side-effect
   recency**, each fail-closed on ambiguity; a brief strand beats a split-brain.
4. **The owner self-fences and (before graduation) sends are epoch-fenced** —
   "loses every write" must include Telegram sends.
5. **At-least-once across a claim in v1, stated honestly**; watermark replication is
   increment E toward exactly-once.
6. **Bounded everything** (claims per tick, per-topic budget, probe breaker), loud
   give-ups, durable refusal traces, episode-deduped operator asks.
7. **Claim suspends the pin** — no reconciler tug-of-war, ever.

## Open questions

None.

> TTL/probe/ceiling knobs are config with defaults derived from the existing
> Case C `deathEvidenceMs` (180s) and lease-transport bounds — frontloaded config,
> not open questions.
