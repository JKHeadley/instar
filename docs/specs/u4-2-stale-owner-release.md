---
title: "U4.2 — Stale-Owner Release: the CMT-1786 auto-failover, built as the evidence upgrade to OwnershipReconciler Case C"
slug: "u4-2-stale-owner-release"
author: "echo"
status: "draft"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
sibling-principles: "The Agent Is Always Reachable; Verify the State, Not Its Symbol; A Refusal Stays a Refusal; Bounded Blast Radius; A Dark Feature Guards Nothing"
lessons-engaged: "stranded-inbound-self-heal.md §Deferred-v2 (CMT-1786 <!-- tracked: CMT-1786 -->, all seven prerequisites walked in §2.7); P19 (bounded loops); P20 (verify the state); P17 (one deduped item); mesh-lease-tick-wedge-rootcause (local memory, topic 27515); Live-User-Channel Proof Before Done"
parent-spec: "docs/specs/U4-mesh-self-healing-index.md; docs/specs/stranded-inbound-self-heal.md; MULTI-MACHINE-SESSION-POOL-SPEC.md; MULTI-MACHINE-SEAMLESSNESS-SPEC.md"
project: "self-healing-mesh (topic 29836)"
depends-on: "OwnershipReconciler (WS1.3 Case C force-claim — the machinery this EXTENDS); SessionOwnership FSM (ownershipEpoch fence, applyOwnershipAction); StrandedTopicSentinel (detection layer, loadBearing); fenced serving lease (the claim ARBITER); ChurnBreaker (claimer-availability composition, §2.1); multiMachine.meshTransport (authenticated probes); PeerEndpointRecorder (advert-set provenance, §2.2.2); WorkingSetPullCoordinator; MessageProcessingLedger; U4.1 (pin suspend interaction, §2.4); U4.4 (lease hand-back moves the claimer role, §2.5/§2.6)"
review-convergence: "2026-07-02T07:28:08.681Z"
review-iterations: 4
review-completed-at: "2026-07-02T07:28:08.681Z"
review-report: "docs/specs/reports/u4-2-stale-owner-release-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-basis: "Operator preapproval for spec approvals in this session (topic 29836, 2026-07-02): 'Full preapproval granted … spec approvals, server restarts, deployment, and all in-scope reversible decisions.' Recorded transparently, not silently self-granted."
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
prerequisites and deferred it as **CMT-1786** <!-- tracked: CMT-1786 -->. U4.2 IS
that deferred v2 <!-- tracked: CMT-1786 -->, with the
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
second OWNERSHIP store (Cross-Store Coherence: the existing record keeps answering
"who owns this topic"; the §2.4 `topic-claim-annotation` kind is deliberately NOT
ownership state — it carries suspension/budget/refusal metadata and can never
answer or fence ownership; R-r3-1). Claims respect the FSM's real terms: a
`transferring` record with `drainInFlight: true` inside the reconciler's drain-grace
window (`DEFAULT_DRAIN_CLAIM_GRACE_MS`, `OwnershipReconciler.ts`) is held back until
the owner's `SessionDrainRunner` reaches a safe point — a mid-drain death rides the
existing `transferring`-timeout recovery, never a raw CAS over it. (R-r2 minor: the
draft's invented "claim-grace" term is replaced by these actual FSM terms.)

**Arbiter:** only the serving-lease HOLDER runs stale-owner claims (single claimer
by construction — matches the MeshRpc RBAC posture where failover claim/release is
router-only). This answers the substrate honestly: the shipped ownership CAS is
per-machine (`LocalSessionOwnershipStore`) with journal convergence, so "only one
peer wins" must come from claimer-uniqueness, not from a cross-machine CAS that does
not exist. Two-machine degenerate case: the surviving machine holds the serving
lease (or takes it via the existing lease failover first), then claims.

**Claimer availability is a stated precondition, and escalation must not share it
(R-r2-1).** Lease-holder-only claiming composes badly with the churn breaker
(`src/core/churnBreaker.ts`): a LATCHED breaker holds deterministic resting roles
(the `preferredAwakeMachineId` machine → awake, every other machine → standby), and
an EXHAUSTED breaker never auto-resets — so an exhausted latch with a DEAD preferred
captain leaves NO lease holder at all. In exactly the target episode that means: no
claim, no §2.6 escalation, and no sentinel either — `StrandedTopicSentinel` early
no-ops when not lease-holder (its gate list: `< 2 machines / not lease-holder / pool
view stale`). Resolution (the quorum-member option, chosen deliberately): the §2.6
ambiguity/stranded escalation is hosted on ANY quorum member — the sentinel's
not-lease-holder gate is relaxed for the DETECTION + ESCALATION path only (named
code change on `StrandedTopicSentinel`), with the item keyed on the episode id so
N machines raising the same strand collapse via the existing P17 pool-wide coalesce
to ONE operator item. The CLAIM stays lease-holder-only. The churn breaker's own
exhausted-HIGH item is a cross-referenced adjacent signal, NOT the accepted surface
— it says the breaker is stuck; it says nothing about stranded topics. Test:
`no-lease-holder-escalation-hosted-on-any-quorum-member`.

### 2.2 The evidence bar (ALL required; fail CLOSED on any ambiguity)

1. **Machine death evidence** (existing Case C bar, with two upgrades): owner
   offline in the pool registry AND observer-stamped `lastSeen` ≥ `deathEvidenceMs`.
   There is **no per-topic heartbeat** — per-topic staleness derives from the owner
   MACHINE's one capacity heartbeat (HTTP path, works git-less); per-topic records
   are written only on claim/release transitions (no write amplification; the L0
   no-git-for-heartbeats rule holds). Clock model: staleness is measured on the
   OBSERVER's monotonic clock from the last VERIFIED heartbeat fold-in (the
   FencedLease-F2 pattern).
   - **Named code fix — the existing input is the wrong input (R-r2-5a):** today's
     Case C staleness feed is SELF-REPORTED wall-clock: `src/commands/server.ts:17092`
     hands the reconciler `lastSeenMs: Date.parse(c.selfReportedLastSeen)`, which
     `MachinePoolRegistry`'s own §L2 header forbids ("liveness + placement freshness
     key on `routerReceivedAt` … NEVER the machine's self-reported timestamp — a
     fast-clocked machine must not appear fresher than it is"). Rewiring that feed to
     the router/observer-stamped arrival time is a NAMED prerequisite code fix of
     this spec — builders extending Case C's evidence MUST NOT extend the
     self-reported input. Wiring test: `case-c-staleness-input-is-observer-stamped`.
   - **Restart must not reset the evidence (R-r2-2):** the observation store is
     in-memory (`MachinePoolRegistry` is rebuilt from heartbeats), so a naive
     "never observed heartbeating ⇒ NOT-expired" rule means that after the CLAIMANT
     restarts, a genuinely dead owner is never observed → never expired →
     auto-failover silently degrades to manual FOREVER — strictly worse than today's
     Case C, which recovers via the git-synced coarse-heartbeat re-feed. Bounded
     bootstrap rule: an owner never observed since claimant boot classifies EXPIRED
     only when BOTH (a) continuous non-observation since boot ≥
     `bootstrapNonObservationMultiple × deathEvidenceMs` (config, default 3×) AND
     (b) the durable registry's last-known heartbeat — the same git-synced
     `coarseHeartbeat` re-feed today's Case C recovers through — is older than
     `deathEvidenceMs`. Before that bound, never-observed-since-boot is classified
     AMBIGUITY and feeds the §2.6 3×TTL operator escalation — never a silent strand.
     The version-skew protection narrows to what it actually protects: absence of
     the NEW per-episode evidence fails closed, while machine-death evidence rides
     the capacity heartbeat every deployed version already emits.
     **Honesty note on condition (b) (R-r3-3):** the git-synced coarse heartbeat
     beats on a ~30-minute cadence, so "(b) coarse beat older than
     `deathEvidenceMs`" (a 180s-scale bound) is weak discrimination — a LIVE
     owner's last coarse beat is routinely older than the bound between beats.
     Live-owner protection in the bootstrap case therefore rests on condition (a)
     (continuous non-observation since boot at `bootstrapNonObservationMultiple ×
     deathEvidenceMs`) plus evidences 2 and 5 (all-transport disproof +
     side-effect recency); (b) is a tie-breaker only — it distinguishes a
     long-dead owner from a recently-alive one, never a live one from a dead one.
     Tests: `bootstrap-never-observed-owner-is-ambiguity-then-expired`,
     `claimant-restart-does-not-strand-auto-failover`.
2. **Multi-transport disproof:** the owner is unreachable via the authenticated
   signed-handshake probe on EVERY advertised transport. The advertisement set must
   be non-empty AND freshness-bounded (older than N heartbeats = ambiguity); a
   single-transport advertisement is automatic ambiguity (the single-rope false-death
   is the exact bug to avoid — surfaced as a U4.5 rope-health line, not claimed
   around). ONE reachability verdict per (owner, episode) — single-flight,
   TTL-memoized, backoff between episodes, shared by all that owner's topics; probe
   timeout well below the lease transport's 30s.
   - **Advert-set provenance (R-r2-5b):** the advertisement set used for the
     all-ropes disproof must bind to the OWNER as authenticated sender —
     `PeerEndpointRecorder` provenance ONLY (endpoints recorded out of the signed
     lease RPC, bound to the cryptographically-verified sender/responder identity,
     written only into THAT peer's entry). The git-backed registry's `lastKnownUrl`
     is writable by ANY machine with repo push and is NOT acceptable disproof input
     — a forger could shrink the advert set to a rope it controls and manufacture
     "unreachable on every transport". Test:
     `forged-advert-set-from-non-owner-rejected`.
3. **Quorum** (verbatim Case C): the claimant observes a majority partition
   (`online × 2 > machines`). Two-machine degenerate: rule 2.1's lease-holder
   arbitration + the self-connectivity proof below stand in.
4. **Claimant self-connectivity proof:** the claimant proves its OWN network is
   healthy within the same window (a successful authenticated probe of a third peer,
   or in the 2-machine case a verified reach of the durable lease authority) —
   a claimer with a broken NIC sees everyone as dead and must never claim.
   **2-machine git-less mesh (R-r2 minor):** when NO durable third-party lease
   authority exists (a git-less 2-machine mesh has nothing durable to verify
   against), the 2-machine claim path is DISABLED — fail closed; detection and the
   §2.6 escalation still run. Test: `two-machine-gitless-claim-path-disabled`.
5. **Owner liveness disproof (not just unreachability):** the owner's last
   AUTHENTICATED side-effect is older than the bound. Mesh-unreachable ≠ dead: a
   machine can lose every peer-to-peer rope yet still reach api.telegram.org and
   keep replying.
   - **Concrete source set + evidence-channel freshness (R-r2-3, part 2):** evidence
     5 reads the claimant's MIRROR of the durable replicated channel — specifically
     the replicated coherence-journal kinds (placement/ownership emissions) plus
     lease/ownership renewals. It does NOT read the machine-local
     `MessageProcessingLedger` SQLite (that ledger never leaves the owner's disk and
     is invisible to a claimant). Because the input is a mirror, recency is only
     meaningful if the mirror is fresh: a SUCCESSFUL sync of that channel within the
     evidence window is REQUIRED; a mirror not successfully synced inside the window
     classifies AMBIGUITY (fail closed) — a stale mirror must never read as "no
     recent side-effects". Telegram sends are structurally invisible to this
     evidence; that residual split-brain slice is assigned, by design, to the owner
     self-fence + the §2.3 emission fence — which graduation already gates on.
     Test: `stale-evidence-mirror-classifies-ambiguity`.
6. **Fresh CAS-authority access + re-read immediately before the claim.**

### 2.3 The other half: the owner fences ITSELF

- **Self-fence (local, no connectivity needed):** an owner that cannot renew its
  ownership/serving participation within TTL stops emitting for its topics — so
  "expired" implies "self-fenced" by construction, closing the outbound-alive
  double-reply path.
- **The TTL-ordering invariant, stated and enforced (R-r2-3, part 1):** "expired
  implies self-fenced by construction" holds ONLY under a strict ordering of the
  bounds: `deathEvidenceMs > selfFenceTtlMs + reconcilerTickMs + clockSkewSlackMs`
  — the claim evidence bound must be STRICTLY greater than the owner's self-fence
  TTL plus one reconciler tick plus clock-skew slack, or a claim can land while the
  owner is still legitimately emitting. This is an INVARIANT of the design, not a
  tuning suggestion, and it is enforced at config validation: a combination that
  violates it is REJECTED at startup with a clear message (the existing multiMachine
  reject-nonsensical-combinations-at-startup pattern). Test:
  `config-validation-rejects-evidence-bound-below-self-fence-ttl`.
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

- **Pins (U4.1 interaction — representation re-decided jointly, R-r3-1/R-r3-2;
  supersedes R-r2-7's ownership-record field):** a stale-owner claim SUSPENDS the
  topic's pin rather than leaving pin↔owner divergence for the reconciler to fight
  — no claim/transfer-back oscillation. Round 2 put the suspension in the
  ownership record as a new optional field; grounding kills that: the
  topic-placement receive-validation STRICTLY rejects unknown fields (`known =
  ['owner','epoch','reason','prevOwner','status','transferTo','timestamp',
  'drainInFlight']`, `JournalSyncApplier.ts:610-612`; an invalid entry marks the
  peer stream suspect and HALTS the batch) and `OwnershipApplier` is a whitelist
  materializer that silently DROPS unknown fields — so a `suspended` field could
  not ride the ownership record: a pre-U4.2 peer would suspect-halt the claimant's
  entire placement stream, and even between U4.2 peers the field would never
  materialize. The REPRESENTATION (R-r3-1): the suspension lives in a NEW separate
  registered replicated record kind, **`topic-claim-annotation`** (keyed
  `topic + episodeId`), validated through the GENERIC envelope path exactly like
  `topic-pin-record` (the `replicatedRegistry.getByKind` branch,
  `JournalSyncApplier.ts:579` — a new registered KIND is additive: peers that
  don't register it simply never sync it, so there is no unknown-FIELD rejection
  surface at all). The ownership record stays UNTOUCHED — zero version-skew risk
  on the placement stream. **The annotation kind is epoch-INDEPENDENT by design
  (R-r3-2)** — ordered by its own HLC via the generic envelope, like pins —
  because an annotation write must NOT be an ownership CAS transition: bumping
  `ownershipEpoch` for a suspension/budget/refusal write would fence a live
  owner's sends the moment the §2.3 emission fence is wired, and contradicts
  §2.2.1's records-written-only-on-claim/release-transitions rule; while NOT
  bumping (if the data rode the ownership record) means the fast-forward-only
  `OwnershipApplier` never propagates the change. One stone, both findings: a
  separate, epoch-independent kind is the only representation that replicates
  without touching the fence — that is the design reason the kind exists. The
  suspension does NOT live in the replicated pin record either: U4.1 freezes the
  replicated pin schema, and the pin is the operator's statement, not the
  claimant's to rewrite. U4.1's `pinState` enum (today `actuated | pending |
  diverged`) RESERVES `suspended-pending-owner-return`, DERIVED AT READ TIME from
  the live suspension annotation — no pin-record write ever occurs.
  `effectivePins()` consults the suspension annotation before adopting or driving
  a pin; a later operator re-pin (fresh HLC) clears the suspension (the operator's
  newer statement wins). Cross-reference: `u4-1-pin-persistence.md` carries the
  matching enum reservation. Pin resumption follows U4.1's sustained-online
  hysteresis when the owner returns. Local pins in the reconciler's cooperative
  path gain the same online-gate the advisory pins already have (named code fix).
  Tests: `claim-suspends-pin-via-annotation-kind-not-pin-or-ownership-record`,
  `operator-repin-clears-suspension`,
  `annotation-kind-passes-generic-envelope-validation-and-never-touches-placement-schema`,
  `annotation-write-never-bumps-ownership-epoch`.
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

**Budgets must survive lease movement (R-r2-4):** the lease — and with it the
claimer role — is MOBILE: U4.4's hand-back moves it automatically and routinely. A
machine-local per-topic claim budget would therefore reset to zero on every lease
move, and pacing/backoff would restart from scratch under exactly the flapping
conditions the budget exists to bound. The per-topic claim budget and its backoff
state are carried on the REPLICATED `topic-claim-annotation` kind (§2.4 —
epoch-independent, HLC-ordered; R-r3-1/R-r3-2: an ownership-record field could
neither pass the strict placement receive-validation nor propagate through the
fast-forward-only applier, and an epoch-bumping budget write would fence a live
owner), so the count follows the topic, not the deciding machine. Only probe memos
(per-(claimant, owner, episode) reachability verdicts) stay machine-local — a
verdict is only meaningful from the machine that judged it.

### 2.6 Honesty surfaces (a refusal stays a refusal)

- **Durable decision trace:** every stale-detect, probe verdict, would-claim
  (dry-run), claim, and REFUSAL lands in `logs/stale-owner-release.jsonl` on the
  deciding machine — a no-claim verdict leaves an artifact, never silence. Dry-run
  logging is state-change-gated per episode (first observation / verdict change /
  would-claim once per topic per episode — the transport first/Nth/recovery
  precedent), never per-tick.
- **Bounded ambiguity, hosted on any quorum member (R-r2-1):** ambiguity persisting
  past ~3× TTL escalates into the SAME per-episode deduped partition attention item
  ("topic looks stranded; I can't prove the owner's state — your call") — never an
  indefinite silent strand. Per §2.1, this escalation is raisable by ANY quorum
  member (episode-keyed, P17-coalesced to one item), so a no-lease-holder mesh —
  the exhausted-breaker + dead-captain composition — still reaches the operator.
  Episode boundaries: 30 min of calm closes an episode; repeat episodes collapse
  via the OwnerSuspectBreaker flap-accounting pattern (≤ one item per flap episode).
- **A declined demote persists — across lease movement (R-r2-4):** the operator's
  "no" durably pins the topic against claim for that episode — conditions drifting
  does not resurrect the ask. The declined-demote pin is persisted as a REPLICATED
  `topic-claim-annotation` record (§2.4 — the named carrier, journal-converged;
  never a sentinel-local file, and never an ownership-record field, which could
  not replicate; R-r3-1), because the claimer
  role moves with the lease (U4.4): a new holder must neither re-ask the operator
  nor claim a topic the operator just declined. "A Refusal Stays a Refusal" must
  survive the refusal's audience changing machines. Test:
  `declined-demote-and-budget-survive-lease-move`.
- **User-facing takeover notice:** the claimed topic gets the existing per-topic
  continuation disclosure (coalesced, durable path) — a conversation never changes
  machines without the user being told once, honestly.

### 2.7 The CMT-1786 prerequisites, walked

1. *Per-topic remote-session-liveness signal* → §2.2.5 (authenticated side-effect
   recency over a freshness-proven mirror), not mere reachability.
2. *Temporal hysteresis* → §2.2.1 death-evidence bound + §2.5 claim budget/backoff +
   episode calm windows.
3. *Claim-time re-assertion* → §2.2.6 re-read before CAS + §2.1 FSM semantics.
4. *Atomic CAS + pin-repoint transaction boundary* → §2.4: the claim CAS and the
   suspension annotation are emitted in the reconciler's single apply path, keyed
   to the same episode id; the CAS stays the sole ownership authority and the
   annotation is level-reconciled — a claim that landed without its annotation is
   re-emitted idempotently on the next tick (R-r3-1; round 2's one-record claim
   is superseded — the annotation is a separate record precisely so it can
   replicate).
5. *Reason-stamped nonce convention* → claims stamp `reason: stale-owner-release`
   + the episode id into the ownership action by EXTENDING the reconciler's existing
   nonce grammar — today `` `${self}:${reason}:${sessionKey}:${now}` ``
   (`OwnershipReconciler.ts:374`) — to
   `` `${self}:${reason}:${sessionKey}:${episodeId}:${now}` `` (it extends this
   exact string; visible in the decision trace + reap-log).
6. *Structural disjointness from OwnershipReconciler* → resolved by INVERSION:
   U4.2 is not a second actor to keep disjoint — it IS Case C's evidence upgrade;
   one actor, so disjointness is by construction.
7. *Unify-or-prove-disjoint with StrandedTopicSentinel* → unified: the sentinel
   remains the DETECTION + operator-notice layer (now quorum-hosted for escalation,
   §2.1); its auto-failover v2 pointer now resolves to this spec; the reconciler is
   the sole ACTUATOR. Sentinel keeps firing during dry-run (its notice is the
   operator's view of would-claims).

### 2.8 Supervision declaration

Tier 0 — argued explicitly against the LLM-Supervised Execution standard
(`docs/LLM-SUPERVISED-EXECUTION.md`: "every critical pipeline must have at minimum a
Tier 1 LLM supervisor"), not silently exempted (R-r2 minor). The claim gate is a
deterministic FENCING path: every predicate is a mechanical check over authenticated
state, and inserting an LLM verdict INTO the fence ADDS split-brain risk — a
hallucinated, mis-parsed, or provider-degraded supervision step inside an ownership
CAS is precisely the class of nondeterminism the fence exists to exclude. Precedent:
the lease pull loop is declared "Tier-0: no LLM", and `StrandedTopicSentinel` is
LLM-free-by-test. Compensating controls in lieu of an inline supervisor: the durable
decision trace (§2.6), the `loadBearing: true` guard posture (§5), and the P19 loud
give-up (§2.5). OPTIONAL Tier-1 offline auditor (named, off the critical path): a
cadenced Haiku job that reads `logs/stale-owner-release.jsonl` + the §2.9 counters
and raises one advisory anomaly item on suspicious shapes (claim bursts, refusal-mix
drift) — it can never gate, delay, or veto a claim. LLM-free on the claim path,
spawn-cap-neutral (asserted by test, the StrandedTopicSentinel pattern).

### 2.9 Status surface (R-r2-6)

`GET /pool/stale-owner-release` — a read-only status route mirroring the
reconciler's existing status pattern (assembled per tick, never stale on early
return): counters for attempts, would-claims (dry-run), and refusals BY REASON
(`transport-ambiguity` | `not-expired` | `quorum-fail` | `self-proof-fail` |
`side-effect-fresh`), the evidence-class distribution, P19 give-ups, probe-breaker
state, and the last episode (id, topic, verdict, at). This is the FD-7-style
telemetry that judges the dry-run soak's false-positive rate BEFORE graduation —
§5's quantified exit criteria are read off this surface plus the decision trace,
not off anyone's impression. One integration test:
`stale-owner-release-status-surface` (route live behind the flag, 503 when dark,
counters advance across a simulated episode).

**`ownershipLeaseState` mapping (R-r2 minor)** — the `/pool/placement` field is
DERIVED from record status + evidence state, per this table:

| `ownershipLeaseState` | derivation |
|---|---|
| `held` | record `active`; owner not expired (no open evidence episode) |
| `stale` | record `active`; owner expired OR an evidence episode is open (ambiguity pending) |
| `releasing` | record `transferring` (including `drainInFlight` within drain-grace), or owner self-fence observed with no claim landed yet |
| `claimed` | record `active` via a `stale-owner-release` force-claim for the current episode; owner return pending (a live suspension annotation present, §2.4) |

## 3. Multi-machine posture (mandatory)

Inherently multi-machine. The ownership record stays the existing replicated L3
state (journal-converged, epoch-fenced) — and it stays SCHEMA-UNCHANGED (R-r3-1):
the per-topic claim budget, the declined-demote pin, and the §2.4 suspension ride
the NEW `topic-claim-annotation` replicated kind (epoch-independent, HLC-ordered),
so refusals and pacing follow the topic across lease movement (R-r2-4) without
touching the placement stream's strict schema. The decision trace is
machine-local BY DESIGN (a verdict is only meaningful from the machine that judged
it); probe memos/reachability verdicts are per-(claimant, owner, episode),
machine-local, TTL-bounded — these are the ONLY machine-local state (R-r2-4).
Version skew: a pre-U4.2 owner never emits the new per-episode evidence — its
absence fails closed (§2.2.1, as narrowed by R-r2-2: machine-death evidence rides
the capacity heartbeat every version emits) and it is never probed on a new route
(§2.2.2 uses the existing signed handshake), so an updated peer can never
false-claim from an old-version owner; a claim never lands unless the claimant runs
U4.2 (the only writer of the new evidence). Pre-U4.2 peers never register the
`topic-claim-annotation` kind and simply never sync it — a new registered kind is
additive, so there is no unknown-field surface on any stream they do consume
(§2.4, R-r3-1). Single-machine install: strict no-op — both the
heartbeat-derivation and claim sides are subordinate to `sessionPool` being live AND
≥2 registered machines. 2-machine git-less mesh: claim path DISABLED, detection +
escalation live (§2.2.4). Rollback tolerance: pre-U4.2 peers never sync the
annotation kind; a flag dropped mid-claim leaves the topic owned by the claimant
via the normal record (servable).

## 4. Tests (tiers declared)

Unit: `expired-plus-all-transports-plus-quorum-plus-self-proof-allows-claim`;
`owner-reachable-on-one-transport-never-claims`; `transport-ambiguity-fails-closed`;
`empty-or-stale-or-single-advert-set-is-ambiguity`; `claimant-egress-down-never-claims`;
`forged-advert-set-from-non-owner-rejected` (R-r2-5b);
`bootstrap-never-observed-owner-is-ambiguity-then-expired` (R-r2-2);
`claimant-restart-does-not-strand-auto-failover` (R-r2-2);
`stale-evidence-mirror-classifies-ambiguity` (R-r2-3);
`config-validation-rejects-evidence-bound-below-self-fence-ttl` (R-r2-3);
`forged-heartbeat-from-non-owner-rejected` (freshness binds to authenticated sender);
`concurrent-claims-arbiter-uniqueness` (lease-holder-only);
`no-lease-holder-escalation-hosted-on-any-quorum-member` (R-r2-1);
`stale-owner-return-loses-writes-and-tears-down` (fence + teardown);
`claim-suspends-pin-via-annotation-kind-not-pin-or-ownership-record` (R-r3-1);
`operator-repin-clears-suspension` (R-r2-7);
`annotation-kind-passes-generic-envelope-validation-and-never-touches-placement-schema`
(R-r3-1 — and a pre-U4.2 peer's placement stream is never suspect-halted by it);
`annotation-write-never-bumps-ownership-epoch` (R-r3-2);
`claims-are-capped-and-paced-per-tick`;
`declined-demote-and-budget-survive-lease-move` (R-r2-4);
`two-machine-gitless-claim-path-disabled`;
`working-set-pull-queued-and-resume-proceeds`;
`flapping-partition-raises-one-item-not-one-per-flap`;
`decision-trace-records-refusals`; `probe-loop-bounded-p19`;
`supervision-tier0-no-spawn-slot`.
Integration: `stale-owner-release-status-surface` (R-r2-6, the FD-7 telemetry
route); `/pool/placement` reports `ownershipLeaseState: held|stale|releasing|claimed`
per the §2.9 derivation table; wiring-integrity (reconciler evidence deps non-null +
delegating, INCLUDING `case-c-staleness-input-is-observer-stamped` — the R-r2-5a
rewire of the `server.ts:17092` self-reported feed); dry-run would-claim lines
state-change-gated.
E2E (feature-alive): two-registry lifecycle — owner darkened → lease-holder claims →
topic servable → owner returns → teardown, zero double-owner.
Live (Test-as-Self, per Live-User-Channel Proof): kill the owner's server; message
the topic through real Telegram; assert the survivor answers with the continuation
disclosure and the claim trace records the episode; verify zero double-reply.

## 5. Rollback / rollout

Config: `multiMachine.sessionPool.staleOwnerRelease` = `{enabled, dryRun,
deathEvidenceMs, probeTimeoutMs, ambiguityCeilingMultiple, maxClaimsPerTick,
bootstrapNonObservationMultiple, selfFenceTtlMs}` (house pattern: `inboundQueue`),
validated at startup against the §2.3 TTL-ordering invariant (R-r2-3 — nonsensical
combinations rejected loudly, never degraded silently), registered in
DEV_GATED_FEATURES (dev-live-in-dryRun → dev-live → fleet; the omitted-`enabled`
dev-gate pattern) and in GUARD_MANIFEST as `loadBearing: true` (critical path:
"topic reachability when its owner dies") so a stalled dark/dry-run posture
classifies loudly per #1318 instead of sitting quiet — this feature class is
literally on the postmortem's existed-but-dark list.

**Graduation past dry-run** REQUIRES ALL of: the §2.3 emission-fence wiring; the
R-r2-5a observer-stamped staleness rewire landed; AND a quantified dry-run soak
judged off the §2.9 surface + decision trace (R-r2 minor): **≥5 would-claims over
≥3 days, each operator-corroborated correct (the owner was genuinely dead/dark at
would-claim time), and ZERO would-claim-wrong** (a would-claim against an owner
later shown alive resets the soak). Agent awareness: CLAUDE.md template gains the
proactive trigger ("user asks 'why did my conversation move machines by itself?' →
read the claim trace + placement ownershipLeaseState" + "'is auto-failover
healthy?' → `GET /pool/stale-owner-release`") + the matching `migrateClaudeMd`
patch. Rollback = drop the flag; ownership reverts to explicit-transfer-only +
sentinel detection (today); lingering `topic-claim-annotation` records are inert
(derived state only — readers that don't consult them lose nothing) and the
suspension is cleared by the next operator re-pin.

## Frontloaded Decisions

1. **U4.2 IS CMT-1786's v2 auto-failover, built as Case C's evidence upgrade** — one
   takeover authority, `ownershipEpoch` as the only fence, prerequisites walked
   (§2.7). No parallel machinery.
2. **The serving-lease holder is the sole claimer — and claimer availability is a
   stated precondition (R-r2-1):** escalation is hosted on any quorum member so an
   exhausted churn breaker with a dead captain still reaches the operator; only the
   claim itself is lease-holder-only.
3. **Evidence = death + transport-disproof + quorum + self-proof + side-effect
   recency**, each fail-closed on ambiguity; a brief strand beats a split-brain.
   Evidence inputs carry PROVENANCE (R-r2-5): observer-stamped staleness (the named
   `server.ts:17092` rewire) and owner-authenticated advert sets
   (`PeerEndpointRecorder` only).
4. **The owner self-fences and (before graduation) sends are epoch-fenced** —
   "loses every write" must include Telegram sends; and the TTL-ordering invariant
   `deathEvidenceMs > selfFenceTtlMs + tick + skew` is enforced at config
   validation (R-r2-3).
5. **A claimant restart never silently disables auto-failover (R-r2-2):**
   never-observed-since-boot is ambiguity (escalated), then bounded-bootstrap
   expiry off the durable coarse-heartbeat re-feed — never NOT-expired forever.
6. **At-least-once across a claim in v1, stated honestly**; watermark replication is
   increment E toward exactly-once.
7. **Bounded everything** (claims per tick, per-topic budget, probe breaker), loud
   give-ups, durable refusal traces, episode-deduped operator asks — and refusals +
   budgets ride the REPLICATED `topic-claim-annotation` kind so they survive lease
   movement (R-r2-4, carrier corrected R-r3-1); only probe memos are machine-local.
8. **Claim suspends the pin — via the `topic-claim-annotation` kind, decided
   jointly with U4.1 (R-r3-1/R-r3-2, superseding R-r2-7's ownership-record
   field, which grounding shows could neither pass the strict placement
   receive-validation nor propagate through the fast-forward applier):** the
   annotation is epoch-independent — never an ownership CAS, so the fence is
   untouched; U4.1's `pinState` reserves `suspended-pending-owner-return` derived
   at read time from the annotation; the pin record is never touched; an operator
   re-pin clears it. No reconciler tug-of-war, ever.
9. **Graduation is telemetry-judged (R-r2-6):** `GET /pool/stale-owner-release` is
   the FD-7-style surface; the quantified soak criteria in §5 are read off it, not
   asserted.

## Open questions

None.

> TTL/probe/ceiling knobs are config with defaults derived from the existing
> Case C `deathEvidenceMs` (180s) and lease-transport bounds — frontloaded config,
> not open questions. The §2.3 ordering invariant constrains, at startup, any
> combination an operator supplies.
