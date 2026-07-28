---
title: "Cross-Machine Ownership-Reconciler Convergence"
slug: "cross-machine-reconciler-convergence"
author: "echo"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
eli16-overview: "cross-machine-reconciler-convergence.eli16.md"
review-convergence: "2026-06-30T03:56:48.328Z"
review-iterations: 3
review-completed-at: "2026-06-30T03:56:48.328Z"
review-report: "docs/specs/reports/cross-machine-reconciler-convergence-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "echo (autonomous pre-approved run, topic 28744 — operator authorized 12h build of this fix; self-approval per autonomous-session-blanket-preapproval)"
---

# Cross-Machine Ownership-Reconciler Convergence

Status: draft (round 3 — post review-round-2)
Related: MULTI-MACHINE-SEAMLESSNESS-SPEC §WS1.3 + §WS2, `reconciler-live-soak-proof` memory, MULTI-MACHINE-SESSION-POOL-SPEC.

## Problem (live-verified, Laptop ↔ Mac Mini, 2026-06-30)

A conversation pinned to machine T while machine S still actively owns it never converges
("stuck move" — the user moves a topic and nothing lands). Driving the WS1.3 OwnershipReconciler
live (out of dry-run on BOTH machines) surfaced THREE root causes. The unit suite passed throughout
because `makeSim` (tests/unit/OwnershipReconciler.test.ts) shares ONE in-memory ownership store
between both simulated machines — masking the separate-per-machine-registry reality of production.
**Fixing that shared-store harness is itself a root cause (Finding LA2), not a side note.**

1. **(FIXED in this change) False-positive clock-skew quarantine.** `refreshPool()` fed each peer's
   COARSE git-synced file `MachineHeartbeat.lastHeartbeatAt` (written every ~30min, 48h-stale-tolerant)
   into the LIVE 5-min clock-skew FSM, permanently quarantining the peer; fresh live beats could never
   reach the 2 clean beats to re-admit. Fix: a `coarseHeartbeat` flag so coarse beats refresh liveness
   but never drive the skew FSM. (MachinePoolRegistry.ts + server.ts refreshPool. Done + unit-tested.)

2. **Pins do not replicate to the owning machine.** The pin (`preferredMachine` intent) is written
   ONLY on the lease-holder's local `TopicPlacementPinStore`, never replicated. The OWNING machine's
   reconciler never sees "you are pinned away" and never initiates the cooperative transfer.

3. **The transferring handoff signal does not replicate.** Ownership "who owns it now" DOES cross
   machines: `emitPlacement` writes `{owner, epoch}` to the CoherenceJournal → replicates to
   `peers/<id>.topic-placement.jsonl` → each machine's `OwnershipApplier` fast-forwards the
   highest-epoch ACTIVE placement. But the cooperative 2-phase handoff's INTERMEDIATE state —
   `transferring(owner=S, transferTo=T, e+1)` — is NOT in the placement entry and the applier only
   materializes `active`, so T never learns "transferring to me" and never claims. FSM (authoritative):
   `active(S, e) → transferring(S→T, e+1) → active(T, e+2) → S tears down`.

## Threat model (declared — Finding LA1, single-agent posture)

Instar is ONE agent across the operator's OWN machines, each with dedicated accounts — NOT a
multi-tenant system (memory: `single-agent-model-no-multitenant-defenses`). So the WS1.3 Round-1
"forged-pin ownership theft by a hostile peer" threat does NOT apply here — a peer IS me. We therefore
DELIBERATELY relax the WS1.3 rule "a replicated pin is NEVER sufficient to trigger owner self-release"
to "a VALIDATED, FRESH replicated pin naming a LIVE known machine MAY trigger the owner's OWN
cooperative transfer (never a force-claim / never a seat-steal)." This relaxation is stated here and
re-documented at `OwnershipReconciler` (Finding INT4) rather than silently dropped. The residual threat
that REMAINS in scope is a STALE or CORRUPT peer stream (a self-inflicted bug, not an attacker): every
mitigation below (HLC ordering, known+live target validation, freshness/TTL, epoch fencing, quarantine,
transferring deadline) defends against THAT, which is the real hazard this very incident proved.

## Design (rides the EXISTING replicated-record + journal rails — no new transport)

### Fix #2 — replicate the pin on the WS2 replicated-record machinery (NOT a bespoke wall-clock kind)
Round 1 (codex/security/adversarial/decision/lessons) unanimously rejected the original "new `topic-pin`
journal kind, newest-`updatedAt`-wins" design: raw wall-clock is the exact clock-skew class this work
fixes, and a journal-written pin became silently authoritative. Revised:

- A new **replicated-record kind** `topic-pin-record` riding `emitReplicatedRecord` (CoherenceJournal),
  the SAME machinery the WS2 stores use — so it inherits **HLC ordering (never wall-clock)**, the
  `<replicated-untrusted-data>` provenance envelope, **tombstone-on-clear**, receiver-side **quarantine**
  (bounded ring + coalesced attention item — never a silent drop), type-clamping, and the per-kind
  **retention + rate-cap + aggregate-budget** discipline (Findings LA3/LA4/S2/S4/SE5). `recordKey = topic`.
  Schema: `{ topic:number, preferredMachine:string(charset-clamped, ≤64), pinned:boolean }` + the standard
  envelope `{recordKey, hlc, op, origin}`; `op:'delete'` is the clear tombstone.
- A `TopicPinReplicatedStore` consumer (mirrors `EvolutionActionsReplicatedStore`) holds replicated pins
  in a **SEPARATE advisory view**, NOT the authoritative local `TopicPlacementPinStore` (Findings
  C1/AD4/INT4/SE7). **Pin precedence is HLC-ordered across BOTH stores, never "local-present-wins"**
  (Finding N3, MED — strongest new hole): a lingering stale LOCAL self-pin on the source machine would
  otherwise mask the FRESHER replicated move-intent and reproduce the very stuck-move this fixes. The
  reconciler resolves the effective pin as the HIGHER-HLC of {local pin, advisory replicated pin}; a write
  to the authoritative local store still happens ONLY via the router-authenticated path (the advisory store
  is read-only input to the precedence decision). **Pins are tombstoned on convergence** (owner == pin
  target active) so a stale local pin cannot persist to fight a future move.
- **Validation before the owner acts on the effective pin** (Findings SE1/SE4/AD3/AD5/N2): the PRIMARY gate
  is membership/liveness — `preferredMachine` must be a KNOWN and currently-ONLINE pool member (Finding N2:
  online-membership is primary precisely because it is skew-PROOF). Freshness is SECONDARY and
  skew-budgeted: HLC ordering decides WHICH pin wins; a coarse staleness backstop (HLC physical component
  vs a generous, skew-tolerant window — NOT a tight wall-clock TTL on a peer-stamped value) only drops an
  obviously-abandoned pin from a long-offline peer (Finding AD5). A replicated pin triggers ONLY the
  owner's cooperative `transfer` (Case A); it NEVER feeds the force-claim path (Case C).
- **Pin writer model + local-pin HLC** (Finding codex-round-3): HLC-ordered precedence across both stores
  (N3) requires the LOCAL authoritative pin to ALSO carry an HLC — today `TopicPlacementPinStore` keys on
  wall-clock `updatedAt`. So the local pin store gains an HLC/version field (migration: a pre-existing pin
  is stamped with an HLC derived from its `updatedAt` on first load, monotone thereafter), and
  `/pool/transfer` writes the local pin AND emits the `topic-pin-record` together (router-authenticated
  write + its replication are one logical step, so a crash cannot leave the two machines' intent divergent
  forever — the next emit/load reconciles). Replays are idempotent by the record's `recordKey:hlc` op-key
  (existing WS2 dedupe). Exactly one replicated record per user pin mutation (Finding S5).
- **Honest-pending** (Finding LA6): when this machine sees a replicated pin for a topic it owns but the
  move has not completed, it surfaces `pendingReplacement`/`since` (the WS1.3 honest-pending surface) and
  `explainTopic` reports it — a non-converging move is visible + deadline-bounded, never silent.

### Fix #3 — replicate the transferring handoff signal (epoch-fenced, validated, deadline-bounded)
- Extend `PlacementData` (the `topic-placement` entry) with OPTIONAL `status`, `transferTo`, `timestamp`,
  `drainInFlight`. Thread them from `r.record` at the **shared `emitPlacement` helper** (server.ts:17015)
  so EVERY transferring-producing CAS site benefits — the reconciler callback, the drain runner
  (`cas{transfer,drain:true}`), and the user-move path (Finding INT2). The journal
  `validate('topic-placement')` branch accepts the new optional fields (absent ⇒ `active`, today's
  behavior — back-compat for older peers, Finding INT2).
- **CORRECT FIELD MODEL (Finding N1, HIGH — verified against code):** the field the cross-machine drain
  grace keys on is the record's **`timestamp`** (`OwnershipReconciler.ts:194`:
  `now - (rec.timestamp ?? 0) < DRAIN_CLAIM_GRACE`), NOT a `transferringStartedAt` — that field does not
  exist on `SessionOwnershipRecord`; output-exclusion's `mayEmit` reads `transferringStartedAt` from a
  ROUTER-stamped opts object that a REPLICATED transferring has never seen. So: (a) the applier materializes
  a `transferring` record preserving the **producer's `timestamp`** (today it hard-stamps `timestamp: now`,
  `OwnershipApplier.ts:127` — that re-stamp is the bug to fix); and (b) on the TARGET, output-exclusion
  derives its `transferringStartedAt` from the carried `timestamp` (the only origin-of-transfer signal that
  crossed the wire) so the disjoint-output window is honored on the receiving side, not silently lost.
- **Bound the carried `timestamp` on materialization — the timestamp analogue of the epoch fence**
  (Finding SE8, MATERIAL): the convergence deadline AND the age-backstop both key off this `timestamp`, so a
  corrupt/stale peer (the in-scope adversary) emitting a FUTURE-dated value would make the deadline never
  elapse and recovery never fire — recreating the permanent-stuck-`transferring` class. On receive, clamp:
  if `timestamp` is in the future beyond a small skew tolerance, floor it to the receiver's `now`; if it is
  implausibly far in the past, cap it. The in-bounds case is preserved verbatim (AD2: drain timing intact);
  only out-of-bounds values are corrected. `drainInFlight` is likewise clamped on receive (a corrupt `true`
  only perturbs local output-exclusion timing — low severity — bounded for consistency). **Principle: never
  trust a peer-supplied timestamp for time-based recovery; bound it by receiver-observed time.**
- **Validate `transferTo`** (Findings SE1/AD3/INT6): when materializing `transferring`, `transferTo` must
  be non-empty, a KNOWN machine, and ≠ owner; otherwise DOWNGRADE to `active(owner)` (never materialize a
  target-less, un-claimable, permanently-stuck `transferring`). **Epoch fence** (Finding SE2): reject an
  epoch jump beyond a sane ceiling over the local epoch (corrupt `epoch=2^53` can no longer wedge a topic
  forever). **Owner-anchored equal-epoch tie-break** (Finding SE6): at equal epoch prefer the entry whose
  stream-owner == entry.owner; a `transferring` from the true owner is canonical (never iteration-order).
- **Stuck-transferring recovery** (Findings DC3/SE4/AD7/G2/LA5/INT7/N4): the reconciler checks
  successor-REACHABILITY before initiating a transfer (don't transfer toward an offline machine), and a
  `transferring` state is bounded by the WS1.3 **convergence deadline** (measured from the clamped carried
  `timestamp`). Two recovery paths, both wired as CONCRETE reconciler cases (Finding N4 — today
  `tick()` no-ops on any `transferring`-not-to-me, OwnershipReconciler.ts:201, so these are NEW cases, not
  prose):
  - **Target died, source alive:** the SOURCE's own reconciler gains a case "I own a `transferring(S→T)`
    whose target T is unreachable past the deadline → **`abort-transfer`** (the FSM already supports it) →
    back to `active(S)`."
  - **Source died, target/bystander alive:** a provably-dead source's stuck transfer is force-claimable by
    the pin target past an age backstop. **Death oracle named** (Finding lessons-N1): "provably dead" = the
    WS1.3 successor-unreachable signal (offline in the pool view past the death-evidence bound), AND the
    decision is gated by the convergence deadline — a momentarily-false-live peer cannot trigger it because
    both the offline-evidence AND the deadline must hold.
  This guarantees Fix #3 cannot create a NEW permanent-stall class.
- **Thrash guard** (Findings AD6/N5): a per-topic post-transfer cooldown (no reconciler-AUTO re-transfer
  for M seconds after a completed handoff) + a hop counter that, past a threshold, surfaces ONE coalesced
  attention item instead of moving again (defends against divergent-pin-view ping-pong during replication
  lag). **The cooldown gates only reconciler-auto re-transfer — an EXPLICIT user pin mutation is exempt**
  (Finding N5), so a user correcting a move within the window is never silently delayed.

### Observability (Findings: conformance-metrics, INT3, INT7, S3, AD8)
- `OwnershipReconciler.explainTopic()` (read-only per-topic decision) + `status()` (last-tick report)
  added (done, unit-tested). Wire a `GET /pool/reconciler` route through the AgentServer ctx
  (`ownershipReconciler?` field) — **503 when absent** (single-machine / pool dark). **Stated contract**
  (security round-2): it is Bearer-gated by the standard server middleware (every route except `/health`)
  and is **credential-free** — it returns only topic ids, machine ids, epochs, and decision reasons, never
  any secret/token field. Adding it to the Registry-First table is a `generateClaudeMd()` edit paired with
  a `migrateClaudeMd` guard (Migration Parity, Finding INT3).
- **Metrics** (conformance finding): per-feature counters make convergence effectiveness gradable —
  `reconcile_transfers`, `reconcile_claims`, `reconcile_stuck_transferring`, `pin_replicated`,
  `pin_quarantined`, time-to-converge — surfaced via the existing per-feature metrics surface.
- **Applier cost** (Findings S3/AD8): both appliers track a per-stream high-water `seq` and SKIP unchanged
  streams (cheap stat/seq check before a full tail read) — no per-tick full re-scan; the placement query
  is a per-topic high-watermark (newest-first), not a flat recent-N that a busy journal can scroll past.
  `topic-placement` gets a finite `rotateKeep` (Finding S1). Under host CPU pressure the applier serves
  last-applied (level-triggered; the next calm tick converges) rather than blocking the event loop (S6).

### Supervision (Finding LA7 + round-2 conformance: LLM-Supervised Execution)
The reconciler is a deterministic FSM/CAS loop, epoch-fenced, making NO policy/judgement decision →
**supervision Tier 0**. This is the CORRECT tier for this critical pipeline, not a shortcut: putting an
LLM inside an ownership-CAS hot loop would be an anti-pattern (non-determinism + latency + cost in a
path that must be provably exactly-one-owner). The "critical pipeline" assurance is instead met
structurally — the deterministic epoch fence, the loop brakes below, and the gradable convergence
metrics + `explainTopic`/`status` observability. An LLM-class supervisor, where wanted, watches the
AGGREGATE convergence HEALTH (e.g. a stuck-transferring rate or a non-convergence alert), never the
per-tick CAS — that aggregate watch is the existing sentinel/attention surface, not part of this loop.

### Loop brakes (round-2 conformance: No Unbounded Loops)
Every repeating behavior here carries its own brakes:
- **Reconciler tick** (per `ws13TickMs`): bounded by the number of pinned topics (small); a per-topic
  **post-transfer cooldown** + **hop-counter cap** (Finding AD6) stops transfer thrash and, past the
  threshold, surfaces ONE coalesced attention item instead of moving again; a CAS that loses repeatedly
  backs off and the topic's `conflictSince` deadline bounds how long it retries before the
  stuck-transferring recovery (revert/tombstone) fires. The transferring state itself is **deadline-bounded**.
- **Applier pumps** (placement + pin): a per-stream **high-water `seq` cursor** means an unchanged stream
  does no work (not an unbounded re-scan); a parse/read failure degrades to "materialized fewer this tick"
  (fail-open, bounded), and a **circuit-breaker** pauses the pump on persistent error rather than spinning;
  under host CPU pressure the pump serves last-applied (load-shed) — level-triggered, the next calm tick
  converges. The epoch fence caps the accepted epoch jump so a corrupt entry cannot drive an unbounded
  advance.
- **Replicated-pin emit**: the journal's per-kind **rate-cap** + aggregate budget bound emit volume; pins
  emit ONLY on user pin mutation (asserted in test, Finding S5), never per-tick.

## Testing-Integrity — fix the harness ROOT CAUSE, don't build around it (Finding LA2 — HIGH)
- **Rebuild `makeSim`** so each simulated machine owns a SEPARATE `SessionOwnershipRegistry`/store, joined
  ONLY by a simulated journal + an `OwnershipApplier` pump the test explicitly drives. Then ALL existing
  reconciler tests (and every future one) exercise the REAL cross-machine topology — the blind shared-store
  harness that masked this bug for months is removed, not supplemented. (P4 Testing Integrity, P14 Distrust
  Temporary Success.)
- **Three tiers** (Testing Integrity Standard): Unit — coarse-heartbeat FSM abstention (done), explainTopic
  parity (done), pin replicated-store HLC newest-wins + tombstone + quarantine + malformed-clamp, applier
  materializes/validates transferring + downgrade + epoch-fence + tie-break, the two-separate-stores
  convergence sequence. Integration — `/pool/transfer` emits a `topic-pin-record`; the replicated record
  applies to a peer's advisory store; `/pool/reconciler` route (200 wired / 503 dark); the cross-kind
  journal budget test. E2E — a true lifecycle test of cross-machine ownership transfer (NOT just wiring):
  two stores + a journal, S transfers → T claims → both converge to active(T) (conformance finding).
- Assert pins emit ONLY on user pin mutation, never on a reconcile transfer / session refresh / heartbeat
  (Finding S5).

## Multi-machine posture (Cross-Machine Coherence — mandatory)
| Surface | Posture |
|---|---|
| `topic-pin-record` (replicated pin) | **replicated** (WS2 rails, HLC, advisory-on-receive; local pin write stays router-authenticated only) |
| `topic-placement` status/transferTo extension | **replicated** (existing placement journal + applier) |
| advisory `TopicPinReplicatedStore` | **machine-local view of replicated data** (each machine materializes its own; not authoritative for force/death) |
| `/pool/reconciler` readout | **proxied-on-read** (a standby proxies to the holder; 503 when dark) |
| reconciler tick / appliers | **machine-local BY DESIGN** (each machine reconciles its own view; the journal is the shared arbiter) |

**Journal consistency model (made explicit — codex round-2 / gemini round-2).** The CoherenceJournal is an
append-only, per-machine-stream, **at-least-once, eventually-consistent** replicated log (HTTP-pulled
deltas between peers). The design depends on exactly these guarantees and is correct under them: ordering
is **fast-forward-MONOTONE on epoch** (a replay/older entry is a no-op — at-least-once is safe), conflict
resolution is **HLC-ordered** for records (skew-proof) and **owner-anchored** for equal-epoch placements,
and convergence is **eventual** — the bounded per-loop latency (applier 15s + reconciler 30s + replication
lag, ~45–90s) is the observable cost, surfaced via `pendingReplacement` so a not-yet-converged move reads
as "moving," never as a silent stall. The journal is NOT a strongly-consistent/linearizable store and the
design never assumes it is.

## Version-skew / rollout (Finding INT1)
Convergence requires BOTH machines on the new version (an old target materializes `transferring` as
`active` and stays stuck; an old owner never receives the replicated pin). This is a DEGRADE to the
pre-fix stuck-move, never a regression. Dev-agent-gated (`ws13Reconcile`/`ws13DryRun`), and the dev pair
upgrades together. The live-soak proof requires a deliberate `ws13DryRun:false` window (dry-run logs
intended CAS but lands none, so it cannot demonstrate convergence — Finding INT7).

## Migration parity
- `topic-pin-record` rides the existing replicated-record kind registry (additive); ships its
  retention + rate-cap + aggregate-budget entry + cross-kind budget test IN THIS PR (Finding LA4).
- `migrateClaudeMd` guard for the `/pool/reconciler` Registry-First entry (Finding INT3).
- No config-default change beyond the existing `ws13Reconcile`/`ws13DryRun` seamlessness gates; an
  optional `ws13PinReplicate` sub-flag allows rolling back the pin-replicator independently during soak
  (Finding DC5).

## Frontloaded Decisions
- **Pin ordering primitive = HLC** (not wall-clock) — resolved per Findings DC2/codex/SE3/AD1/INT5/LA3.
- **Replicated pin authority = advisory-only, validated, cooperative-transfer-trigger-only** (never
  force-claim) under the explicitly-declared single-agent threat model — resolved per LA1/AD4/INT4.
- **Stuck-transferring = deadline-bounded + successor-reachability-gated + age-backstop** — resolved per
  DC3/LA5 (a transferring handoff is NOT allowed to wait forever).
- **Test harness = rebuild makeSim to separate-stores** (root fix, not a supplemental test) — resolved
  per LA2.
- **Pin replication shares the `ws13` gate** with an optional `ws13PinReplicate` sub-flag for independent
  soak rollback — resolved per DC5.

## Open questions
*(none)*
