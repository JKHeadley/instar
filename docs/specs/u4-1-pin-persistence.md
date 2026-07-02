---
title: "U4.1 — Pin Persistence Across Lease Handover: graduate and harden the WS1.3 pin machinery"
slug: "u4-1-pin-persistence"
author: "echo"
status: "draft"
parent-principle: "Verify the State, Not Its Symbol — a pin is durable operator intent, and the placement read must reflect the VERIFIED actual owner, not the intent record"
sibling-principles: "The User Experience Is the Product; Cross-Store Coherence Is an Invariant; Know Your Principal; A Dark Feature Guards Nothing"
lessons-engaged: "P14 (a recurrence is a root cause); P17 (one deduped attention item); P19 (no unbounded loops); P20 (verify the state); L8 (active follow-through); B6/B9 (ground against deployed code); Maturation Path; over-eager-gap-conclusions (local memory)"
parent-spec: "docs/specs/U4-mesh-self-healing-index.md; MULTI-MACHINE-SESSION-POOL-SPEC.md"
project: "self-healing-mesh (topic 29836)"
depends-on: "TopicPlacementPinStore; TopicPinReplicatedStore (kind topic-pin-record, gates multiMachine.seamlessness.ws13PinReplicate/ws13Reconcile); OwnershipReconciler (WS1.3); PlacementExecutor; GET /pool/placement; G3 dark-but-load-bearing guards classification (#1318)"
---

# U4.1 — Pin Persistence: graduate and harden the WS1.3 pin machinery

## 1. Problem — corrected root cause

When the operator deliberately pins a topic to a machine ("run this on the mini"),
that pin can silently evaporate after a lease move or machine bounce (the
`mesh-captain-flip-playbook` memory: "pins can evaporate — re-check placement").

**The machinery to prevent this already exists on main and this spec does NOT
rebuild it.** Current main ships: a durable, atomic-JSON, HLC-stamped local
authoritative pin store (`src/core/TopicPlacementPinStore.ts`); a replicated
advisory pin record (`src/core/TopicPinReplicatedStore.ts`, journal kind
`topic-pin-record`, HLC-ordered, receive-clamped); and a level-triggered
convergence controller (`src/core/OwnershipReconciler.ts`, WS1.3) that consumes
merged advisory pins and drives cooperative transfers. The REAL causes of observed
evaporation are five specific defects in and around that machinery:

1. **It ships dark/dry-run** (`ws13PinReplicate` dark on the fleet; `ws13Reconcile`
   dry-run) — the exact "A Dark Feature Guards Nothing" failure; the standard's
   earned-from section names pin persistence among the dark automations of the
   2026-07-01 incident.
2. **Unpin is unwired**: `buildTopicPinTombstone` has ZERO callers
   (`src/server/routes.ts:13401` emits only the PUT), and
   `OwnershipReconciler.effectivePins()` (≈line 216) adopts a replicated advisory
   pin whenever no local pin exists — so an operator's unpin (local `clear()`)
   is silently REVERSED by the stale replicated PUT on a later tick or handover.
   A live bug today.
3. **Corrupt-file silent wipe**: `TopicPlacementPinStore.load()` resets to `{}` on a
   corrupt file and the next `persist()` makes the wipe permanent — success-shaped
   total loss of operator intent (violates "A Refusal Stays a Refusal"'s
   loud-terminal-outcome clause).
4. **The replication carrier can drop pins by construction**: `topic-pin-record`
   rotates at 2MB × keep-4 (`CoherenceJournal.ts:308`) and the advisory read is a
   newest-500 tail window (`READER_MAX_LIMIT` clamp; the wiring passes a misleading
   `limit: 2000`, `server.ts:17076`) — a pin set once falls out of the window/archive
   as other topics churn.
5. **No actuation verification**: nothing verifies the topic actually LANDED on the
   pinned machine after convergence (the symbol is reported, the state is not) — the
   exact "pinned but never actuated" failure the User-Experience standard's
   State-Convergence clause was earned from.

## 2. Design — six increments, all against the EXISTING machinery

**A. Graduation + load-bearing registration.** Register `ws13PinReplicate` +
`ws13Reconcile` as `loadBearing: true` in the guards manifest (critical path:
"deliberate placement persistence"), so their dark/dry-run posture classifies as
`loadBearingSoaking`→`loadBearingGap` per #1318 instead of sitting silent. Ladder
per the Maturation Path standard: dev-live(dryRun) → dev-live → fleet, with explicit
dryRun-exit criteria (≥5 would-act verdicts over ≥3 days each matching what manual
placement would have done, zero would-act-wrong verdicts). No new flag:
**graduating the existing `ws13` family IS the feature**; `sessionPool.pinPersistence`
(the draft's proposed new gate) is dropped.

**B. Unpin lifecycle (fixes defect 2).** Wire `buildTopicPinTombstone` at the
`clear()` chokepoint (every unpin/decommission emits an HLC-stamped tombstone);
`effectivePins()` and any replay honor tombstones by HLC order (a cleared pin can
never be resurrected by a stale replicated PUT). Machine deregistration clears that
machine's pins via the same tombstone path with ONE coalesced notice. A later
`POST /pool/transfer` re-pins (same key, newer HLC — matches the store's documented
model).

**C. Loud durability (fixes defects 3+4).** Corrupt pin file → quarantine-aside +
ONE deduped attention item + resolve-to-unknown; never wipe-and-persist. The
`topic-pin-record` stream becomes answer-complete: `rotateKeep: 0` (pin volume is
tiny — one compact record per ever-pinned topic), and the advisory-read caller drops
the misleading over-clamp limit (reads are mtime/lastSeq-gated so the 30s tick does
not re-read an unchanged journal; TokenLedgerPoller pattern).

**D. Convergence + actuation verification (fixes defects 1+5).** ONE convergence
engine: becoming placement router (lease acquisition or boot) triggers one immediate
`OwnershipReconciler.tick()` — replay is a reconciler INPUT, never a second
transfer-initiating pass — and `PlacementExecutor.decide()` seeds `topicMetadata`
from the pin stores for NEW placements. Convergence actions are lease-epoch-fenced
(a stale router's tick initiates nothing), debounced by the reconciler's existing
`pinStableMs`, and PACED (bounded moves per tick; a lease flap can never trigger a
transfer storm; test `replay-is-bounded-and-paced`). After convergence, the
placement read reflects the VERIFIED actual owner vs the pin: `GET /pool/placement`
gains `pinState: actuated | pending | diverged` + `pinHeldSince`. `diverged`
(desired≠actual persisting past a bounded window) raises ONE deduped attention item
per episode (P17) — declarative intent with no controller escalation is a wish.

**E. Pending-pin honesty (offline pinned machine).** Today's shipped contract is
preserved and made honest: a hard pin to an unavailable machine stays QUEUED
(never re-routed — `PlacementExecutor.ts:198-205`), surfaced as `pinState: pending`
with the pinned machine's offline status named. Three brakes: (i) fulfilment on
return requires a SUSTAINED-online window (reuse the reconciler's stability
debounce; a flapping machine never triggers ping-pong — mirror of U4.4's
hysteresis); (ii) a pending pin older than a bounded age raises ONE deduped
attention item offering fulfil-or-unpin (covers the decommissioned/rebuilt-machineId
case where the old id never returns); (iii) pin-driven transfers of a topic with a
LIVE autonomous run defer indefinitely as `pending` with that same attention escape —
the reconciler's safe-point deadline override does NOT apply to pin-driven moves,
and the consent gate is never auto-confirmed or retried in a loop.

**F. Quota interaction — reaffirmed, not changed.** The shipped hard-pin is
quota-blind BY DESIGN (`PlacementExecutor.ts:199-210`: the user's explicit pin beats
the quota gate, flagged `pinned-machine-quota-blocked`). This spec KEEPS that:
peer-heartbeat `quotaState` is lower-trust remotely-asserted data and must never
evict a topic from its operator-pinned machine. (The draft's contrary claim was
factually wrong and is withdrawn.)

**pinnedBy (Know Your Principal).** A NEW LOCAL-ONLY provenance field on
`TopicPlacementPinStore`: `{kind: 'operator', platform, uid}` resolved from the
topic's auto-bound verified operator (`TopicOperatorStore`) when the authenticated
request carries one, else `{kind: 'agent', sessionRef}` (a Bearer-authed
agent-initiated transfer is a legitimate pin author). It is NEVER replicated — the
replicated `topic-pin-record` stays deliberately non-PII (`{topic, preferredMachine,
pinned, deletedAt}` + envelope), so no schema change, no version-skew field-drop
hazard, no PII-at-rest change on peers. Cross-machine, a pin's authority derives
from the authenticated envelope origin + the existing advisory-pin validation
(known + online machine, charset-clamped machine id, HLC order, tombstone respect) —
never from a name in the record. `pinnedBy` is serve-time length-clamped on the
Bearer-gated read surface.

## 3. Multi-machine posture (mandatory)

- **Pin record:** REPLICATED via the existing `topic-pin-record` advisory stream
  (envelope-validated, HLC-ordered, receive-clamped, tombstone-respecting). The
  replicated copy remains ADVISORY per the store's documented C1/AD4/LA1 posture:
  it can trigger only cooperative convergence through the reconciler — never a
  force-claim, never a direct write to a peer's authoritative local store.
- **Conflict rule:** HLC-highest-wins via the existing `compareHlc`
  (physical→logical→node) — NEVER wall-clock `pinnedAt`, which is display/audit
  metadata only. Divergence is surfaced two ways: `pinState: diverged` on the
  placement read, and a daily G1 coherence-audit line item checking the
  local-vs-replicated pin agreement invariant (the Cross-Store Coherence standard's
  declared-invariant requirement for the two stores answering "where is topic N
  pinned?").
- **pinnedBy:** machine-local BY DESIGN (PII posture; see §2F).
- **Version skew:** an old-version router runs no lease-acquisition tick — behavior
  degrades to today's 30s reconciler cadence (never worse than today); no new
  replicated fields means no field-drop hazard. Single-machine install: the sole
  machine always honors its own local pins; replication paths are no-ops.
- **Backup posture:** `state/session-pool/topic-pins.json` is deliberately EXCLUDED
  from backups (reconstructable via replication; restoring a pin snapshot onto
  another machine has the stale-resurrection hazard — mirrors the pr-hand-leases
  precedent). Declared here so the silence is a decision, not an omission.

## 4. Tests (tiers declared)

Unit: `unpin-emits-tombstone`; `stale-replicated-pin-never-resurrects-after-unpin`;
`hlc-orders-pin-vs-tombstone` (skew-proof, never wall-clock);
`corrupt-pin-store-quarantines-loudly-never-wipes`; `pending-pin-fulfilment-requires-sustained-online`;
`pin-driven-move-defers-on-live-autonomous-run-no-deadline-override`;
`replay-is-bounded-and-paced`; `pinnedBy-resolves-operator-binding-else-agent-kind`.
Integration: `lease-acquisition-triggers-one-reconciler-tick` (epoch-fenced — a
stale router's tick initiates nothing); `placement-read-reports-actuated-vs-pending-vs-diverged`;
`aged-pending-pin-raises-one-deduped-attention-item`; `topic-pin-record-stream-is-answer-complete`;
`quota-blocked-pinned-machine-still-wins-flagged` (reaffirms shipped semantics);
wiring-integrity: reconciler's pinStore/replicated-store deps non-null and delegating
(the store's own 2026-06-30 always-null wiring death).
E2E (feature-alive): pin on A → lease moves to B → B's acquisition tick converges →
placement read shows `actuated` on A — the full loop against real stores.

## 5. Rollback / rollout

No new flag. The ws13 family graduates per §2A ladder with the G3 load-bearing
classification making a stalled soak LOUD. Rollback = re-darken the ws13 flags
(existing levers); tombstones and quarantine hardening are strict bug-fixes that
remain (they change no placement behavior when dark). Re-enable after a long dark
period cannot replay ancient intent: tombstones + the answer-complete stream keep
the record set current, and the aged-pending-pin attention item (not a silent move)
is the path for any pin older than its bound.

## Frontloaded Decisions

1. **Graduate + harden WS1.3; build nothing parallel.** One store family, one
   convergence engine (the reconciler), one gate family (`ws13*`). The draft's new
   record shape/gate/replay-actor are withdrawn.
2. **Quota-blind hard-pin stays** (deliberate shipped semantics; peer-asserted
   quotaState never evicts operator intent).
3. **HLC-highest-wins is the only conflict rule**; `pinnedAt` is display-only.
4. **pinnedBy is local-only provenance** ({operator|agent} domain from the verified
   topic-operator binding; replicated record stays non-PII).
5. **Pending-pin: queued-never-rerouted preserved**, with sustained-online
   fulfilment hysteresis, a bounded-age attention escape, and consent-gate deference
   (no deadline override for pin-driven moves).
6. **Corrupt store quarantines loudly; journal stream answer-complete
   (rotateKeep: 0)** — both are correctness fixes to the foundation, in scope here.
7. **Actuation verification is part of the feature** (pinState on the placement
   read + G1 agreement-invariant line): a pin without verify-after is a wish.

## Open questions

None.

> Windows and bounds (sustained-online hysteresis, pending-pin age bound, moves-per-tick
> cap, divergence window) are config knobs defaulted from the reconciler's existing
> `pinStableMs`/debounce family — frontloaded config, not open questions.
