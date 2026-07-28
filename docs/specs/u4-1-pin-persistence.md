---
title: "U4.1 — Pin Persistence Across Lease Handover: graduate and harden the WS1.3 pin machinery"
slug: "u4-1-pin-persistence"
author: "echo"
status: "draft"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
sibling-principles: "Verify the State, Not Its Symbol; Cross-Store Coherence Is an Invariant; Know Your Principal; A Dark Feature Guards Nothing"
lessons-engaged: "P14 (a recurrence is a root cause); P17 (one deduped attention item); P19 (no unbounded loops); P20 (verify the state); L8 (active follow-through); B6/B9 (ground against deployed code); Maturation Path; over-eager-gap-conclusions (local memory)"
parent-spec: "docs/specs/U4-mesh-self-healing-index.md; MULTI-MACHINE-SESSION-POOL-SPEC.md"
project: "self-healing-mesh (topic 29836)"
depends-on: "TopicPlacementPinStore; TopicPinReplicatedStore (kind topic-pin-record, gates multiMachine.seamlessness.ws13PinReplicate/ws13Reconcile); OwnershipReconciler (WS1.3); PlacementExecutor; HybridLogicalClock (receive()/SkewRejection); CoherenceJournalReader; GET /pool/placement; G3 dark-but-load-bearing guards classification (#1318)"
review-convergence: "2026-07-02T07:34:23.716Z"
review-iterations: 5
review-completed-at: "2026-07-02T07:34:23.716Z"
review-report: "docs/specs/reports/u4-1-pin-persistence-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-basis: "Operator preapproval for spec approvals in this session (topic 29836, 2026-07-02): 'Full preapproval granted … spec approvals, server restarts, deployment, and all in-scope reversible decisions.' Recorded transparently, not silently self-granted."
---

# U4.1 — Pin Persistence: graduate and harden the WS1.3 pin machinery

**Parent-principle re-home (R-r2).** This spec's parent is the constitution's
**"The User Experience Is the Product — Reachability, Responsiveness, and Coherence
Are Sacred"**: its sub-standard #1 (**State Convergence**) names "a placement pin"
verbatim — *"every declarative desired-state the system records (a placement pin, a
lease) has an owning reconciler that drives actual→desired within a bounded time or
escalates loudly. Declarative intent with no controller is a wish."* This spec IS
that clause's owning-reconciler + bounded-time + loud-escalation requirement made
real for pins. P20 (*Verify the State, Not Its Symbol*) stays engaged as a sibling
principle — the placement read must reflect the VERIFIED actual owner, not the
intent record.

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
evaporation are seven specific defects in and around that machinery:

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
   newest-500 tail window — `READER_MAX_LIMIT = 500` is a HARD clamp inside
   `CoherenceJournalReader` (`CoherenceJournalReader.ts:49`, applied at `:644`
   regardless of the requested limit; the wiring's `limit: 2000` at
   `src/commands/server.ts:17076` is silently clamped to 500). Entries accumulate
   per pin EVENT (every transfer emits a PUT), so a long-untouched topic's winning
   record falls out of the window/archive as other topics churn. (R-r2-3)
5. **No actuation verification**: nothing verifies the topic actually LANDED on the
   pinned machine after convergence (the symbol is reported, the state is not) — the
   exact "pinned but never actuated" failure the User-Experience standard's
   State-Convergence clause was earned from.
6. **No HLC skew gate on replicated pins** (R-r2-1): `coerceHlc`
   (`HybridLogicalClock.ts:195`) validates SHAPE only (non-negative-integer
   physical/logical, non-empty node) — it accepts any future-dated physical.
   `JournalSyncApplier`'s registered-kind receive-validation clamps fields but
   applies no skew gate on record HLCs. Under HLC-highest-wins, a future-skewed
   stamp on a replicated pin beats every honest tombstone forever — defeating the
   defect-2 fix — and with `rotateKeep: 0` (defect-4 fix) the poisoned record is
   retained IMMORTALLY. The defense already exists UNWIRED:
   `HybridLogicalClock.receive()` returns a typed `SkewRejection` when the remote
   physical exceeds the reference by more than the clamped `maxDriftMs`
   (`clampMaxDriftMs`: floor 60s, ceiling 15min, default 5min;
   `HybridLogicalClock.ts:113-134,327-341`). Nothing on the pin path calls it.
7. **Case-A transfer toward an offline pinned target churns forever, silently**
   (R-r2-2): `effectivePins()`'s known-and-online filter applies ONLY to ADVISORY
   replicated pins — a LOCAL pin naming an offline machine passes straight through.
   Case A (owner==self, `OwnershipReconciler.ts:~309-326`) then initiates a
   cooperative transfer toward `pin.preferredMachine` with NO liveness check on the
   target: the target never claims → the N4 abort fires after `transferDeadlineMs`
   (default 120s, `DEFAULT_TRANSFER_DEADLINE_MS`) → the conflict is re-observed on
   the next tick → transfer/abort churn every ~2.5 minutes, forever, with no signal.

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

*Manifest constants (R-r2).* The guardManifest contract
(`src/monitoring/guardManifest.ts:54-64`) makes `criticalPath` REQUIRED when
`loadBearing`, and `declaredLoadBearingAt` (valid ISO) REQUIRED when
`soakWindowDays > 0`. The entries therefore declare, as manifest constants:
`criticalPath: "deliberate placement persistence (operator pin survives lease
handover and machine bounce)"`, `soakWindowDays: 30`, `declaredLoadBearingAt:
<the graduation PR's merge date, stamped in that PR>`. **`expectRuntime` honesty:**
`expectRuntime: true` is declared ONLY together with actually building the
reconciler's GuardRegistry self-registration (a `guardStatus()` on
`OwnershipReconciler` registered at boot, mirroring
`guardRegistry.register('monitoring.resumeQueue.enabled', …)` in
`src/commands/server.ts`) — that registration is in scope for this increment; if it
were ever cut, `expectRuntime` stays `false` (a manifest that expects a runtime
report nobody sends is a standing false alarm).

**B. Unpin lifecycle (fixes defect 2).** Wire `buildTopicPinTombstone` at the
`clear()` chokepoint (every unpin/decommission emits an HLC-stamped tombstone);
`effectivePins()` and any replay honor tombstones by HLC order (a cleared pin can
never be resurrected by a stale replicated PUT). Machine deregistration clears that
machine's pins via the same tombstone path with ONE coalesced notice. A later
`POST /pool/transfer` re-pins (same key, newer HLC — matches the store's documented
model). *One HLC per pin mutation (R-r2):* the transfer route currently calls
`ctx.topicPinStore.set(topicId, target, plan.setPin ?? true)` WITHOUT the `hlc`
argument (`src/server/routes.ts:13391`) despite the store contract
(`TopicPlacementPinStore.ts:79` and its docblock: "pass the same HLC that the
replicated `topic-pin-record` carried so local and replicated pins compare
cleanly"). This increment REQUIRES every pin mutation to mint ONE HLC and stamp
BOTH the local `set()`/`clear()` AND the journal emit (`buildTopicPinPut` /
`buildTopicPinTombstone`) with that same stamp — otherwise the local-vs-replicated
comparison degrades to a derived wall-clock and the HLC-highest-wins rule is a
symbol, not the state.

**C. Loud durability (fixes defects 3+4).** Corrupt pin file → quarantine-aside +
ONE deduped attention item + resolve-to-unknown; never wipe-and-persist. As part of
the same change, the factually wrong `load()` catch comment "the pin is advisory,
not authoritative" (`TopicPlacementPinStore.ts:63`) is corrected — THIS store is the
authoritative local record of operator intent (the replicated `topic-pin-record` is
the advisory one), which is exactly why a silent wipe is total loss (R-r2).

*Answer-complete read — the real mechanism (R-r2-3).* `rotateKeep: 0` on
`topic-pin-record` fixes STORAGE (nothing is ever rotated away; pin volume is tiny —
one compact record per ever-pinned topic), but storage alone does not fix the READ:
every advisory read funnels through `CoherenceJournalReader`'s hard
`READER_MAX_LIMIT = 500` newest-tail clamp, so a long-untouched topic's winning
record still falls out of the newest-500 window as other topics churn — defect 4
recurs at a farther horizon. The read is therefore redesigned (decided, not
optional):

- **Boot-time full-stream fold.** A dedicated fold path (`foldPinRecords()` on the
  reader, used only for `topic-pin-record`) streams EVERY entry of the kind — active
  file AND archives, in order, across the OWN stream **and every peer-replica
  stream** (the fold MUST cover replica streams; a fold over the own stream alone
  would blind the effective map to every peer's pins) — WITHOUT the
  `READER_MAX_LIMIT` clamp (the clamp exists to bound generic tail reads), folding
  into a per-key latest map by HLC (tombstone-respecting per §2B). *The honest
  bound (R-r3-3):* round 2 cited "one-record-per-topic compaction pressure" — NO
  such mechanism exists (the journal is append-only; `rotateKeep: 0` retains every
  archive; entries accumulate per pin EVENT). The true fold bound is the **total
  retained `topic-pin-record` bytes across active + archive files, own and
  peer-replica streams**. That is honestly small: pins are OPERATOR actions —
  low-frequency by nature — so the worst realistic case is thousands of pin events
  = single-digit MB, folded once at boot. Backstop, never assumption: a **fold
  byte-guard** (`ws13FoldMaxBytes`, default 64MB) that on breach folds NEWEST-FIRST
  up to the budget and LOUDLY escalates — ONE deduped attention item naming the
  truncation (which byte ranges of which streams went unfolded) — never a silent
  truncation. If pin event volume ever grows toward the guard, per-key
  rewrite-compaction at rotation is the named tracked follow-up
  <!-- tracked: CMT-1875 --> (not built now; the guard makes the need visible
  instead of silent).
- **Incremental offset-tracked tail.** After the boot fold, the 30s tick updates the
  map incrementally: per-journal-file byte offsets are tracked and only appended
  bytes are re-scanned — the TokenLedgerPoller pattern made explicit (idempotent
  re-scan via byte offsets; file-identity change resets the offset). An unchanged
  journal costs zero re-read.
- **The wiring consumes the fold map**, replacing the `query({ kind:
  TOPIC_PIN_RECORD_KIND, limit: 2000 })` tail read at
  `src/commands/server.ts:17076` — the misleading over-clamp limit dies with it.
- A per-key compacted snapshot store was considered and REJECTED: it introduces a
  second store that must be kept coherent with the journal (a new Cross-Store
  Coherence invariant) for no capability the fold+tail does not already provide.

The named test `topic-pin-record-stream-is-answer-complete` is satisfiable against
this design by construction: >500 pin events across many topics plus a rotation, and
the fold still returns the winning record for a topic untouched since the earliest
events.

*HLC skew gate (fixes defect 6) (R-r2-1; composition + durability hardened
R-r3-1/R-r3-2).* The pin advisory merge/fold skew-gates every record HLC through
the existing `HybridLogicalClock.receive()` contract (clamped `maxDriftMs`, default
5min, floor 60s / ceiling 15min): a record whose physical component is
future-skewed beyond the clamp is REJECTED from the fold — never merged, never able
to win `compareHlc`.

- **The fold-side gate is the SOLE skew-exclusion authority (R-r3-1).** Round 2's
  "defense-in-depth" applier-door refusal is DROPPED. `JournalSyncApplier`'s only
  per-entry refusal path marks the peer stream suspect and HALTS the batch at that
  seq (rule 2, `JournalSyncApplier.ts:462-467`; seq must be exactly
  `lastHeldSeq + 1`, `:544`) — so refusing one misclocked pin record at the door
  would permanently wedge that peer's ENTIRE `topic-pin-record` stream: the
  quarantine attention item never fires (the record never lands to be
  quarantined), and every tombstone behind it stops flowing (the defect-2 fix
  dies). A skewed record is therefore ACCEPTED-AND-PERSISTED at the applier
  (stream liveness preserved) and excluded at the fold — which is exactly why the
  fold-side gate is load-bearing: the fold is the only place a skew exclusion can
  act per-record without collateral damage to the rest of the stream.
- **The quarantine is STICKY — durable across clock progress (R-r3-2).**
  `HybridLogicalClock.receive()` rejects on `remote.physical −
  max(last.physical, poolReference) > maxDriftMs`
  (`HybridLogicalClock.ts:333-341`) — that reference MOVES with wall time, so a
  +Δ-skewed record would silently un-quarantine after ~Δ and then WIN `compareHlc`
  over every tombstone and re-pin the operator minted during the quarantine window
  (retroactive resurrection; a point-in-time exclusion cannot hold across a time
  advance). Therefore: on first skew rejection, `(recordKey, offending hlc)` is
  persisted to a durable quarantine set stored beside the pin store
  (`state/session-pool/topic-pin-skew-quarantine.json`, atomic-JSON like its
  sibling), and every future fold excludes any record matching that exact
  `(key, hlc)` REGARDLESS of clock progress. **Clearing (R-r4-1 — dismissal is not
  re-admission):** the ONLY self-clearing path is supersession by a NEWER honest
  record — a higher HLC that passes the gate — at which point the quarantined
  entry is dead by ordering anyway. Operator ack of the attention item closes the
  NOTIFICATION and nothing else: the sticky entries remain excluded (acking before
  the skew delta elapses must not re-open the episode, and acking after it must
  not re-admit the poison to beat quarantine-window tombstones — either arm would
  recreate the exact resurrection this fix exists to prevent, triggered by the
  natural act of dismissing an alert). A deliberate re-admit exists as its own
  explicit per-record action (`re-admit quarantined record` on the item's detail
  surface) — an authority decision distinct from dismissing a notification.
  Bound: tiny — one entry per poisoned record, and poisoned records are rare by
  construction.

Disposition of a rejected record remains **quarantine + ONE deduped attention item**
(key `u41:pin-hlc-skew:<originMachineId>`, coalescing all quarantined records from
that origin), NEVER a silent drop: the record stays on disk, excluded from the
effective map, so a legitimate-but-misclocked peer is diagnosable rather than
erased. Without this gate, tombstones (§2B) and `rotateKeep: 0` (above) would make
a future-skewed pin IMMORTAL — the skew gate is what makes both fixes sound.

**D. Convergence + actuation verification (fixes defects 1+5).** ONE convergence
engine: becoming placement router (lease acquisition or boot) triggers one immediate
`OwnershipReconciler.tick()` — replay is a reconciler INPUT, never a second
transfer-initiating pass — and `PlacementExecutor.decide()` seeds `topicMetadata`
from the pin stores for NEW placements. Convergence actions are lease-epoch-fenced
(a stale router's tick initiates nothing), debounced by the reconciler's existing
`debounceMs` (`DEFAULT_DEBOUNCE_MS = 30_000`, `OwnershipReconciler.ts:145` — the
draft's `pinStableMs` was a nonexistent knob and is corrected here; R-r2-5), and
PACED (bounded moves per tick via `ws13MaxMovesPerTick`; a lease flap can never
trigger a transfer storm; test `replay-is-bounded-and-paced`). After convergence,
the placement read reflects the VERIFIED actual owner vs the pin:
`GET /pool/placement` gains `pinState` + `pinHeldSince`.

*`pinState` enum (R-r2; joint value renamed R-r3-4):* `actuated | pending |
diverged | suspended-pending-owner-return`. The fourth value is RESERVED here so
the two sibling specs' schemas compose — round 2 shipped it here as
`pin-held-pending-owner-return` while U4.2 reserved `suspended-pending-owner-return`;
a joint enum must be ONE string, and U4.2's name wins (R-r3-4). It represents
U4.2's pin suspension when a stale owner's topic is claimed (a claim SUSPENDS the
pin rather than leaving pin↔owner divergence for the reconciler to fight). Its semantics live entirely in
`docs/specs/u4-2-stale-owner-release.md` §2.4 — U4.1 machinery never emits it, but
readers/renderers of `pinState` MUST tolerate it from day one. *`pinHeldSince`
source (R-r2):* declared as the winning pin record's **HLC physical component** —
never a separate wall-clock read, so the displayed hold-start can never disagree
with the ordering authority.

`diverged` (desired≠actual persisting past `ws13DivergedWindowMs`) raises ONE
deduped attention item per episode (P17) — declarative intent with no controller
escalation is a wish.

*P17 dedup keys + episode boundaries (R-r2).* The new attention items (including
the skew and fold-guard items from §2C) are keyed and bounded as follows — one
item per episode, re-raised only when a NEW episode opens:

| Item | Dedup key | Episode opens | Episode closes |
|---|---|---|---|
| Corrupt pin store quarantined | `u41:pin-corrupt:<storeFilePath>` | a quarantine event | operator ack (attention resolve) |
| Aged pending pin | `u41:pin-pending-aged:<topicId>` | pending age > `ws13PendingPinMaxAgeMs` | pin fulfils, or is cleared/tombstoned |
| Pin diverged | `u41:pin-diverged:<topicId>` | desired≠actual persists past `ws13DivergedWindowMs` | `pinState` returns `actuated`, or the pin is cleared/tombstoned |
| Skew-quarantined pin record | `u41:pin-hlc-skew:<originMachineId>` | first quarantined record from that origin | operator ack closes the NOTIFICATION only (sticky entries remain excluded — R-r4-1), or every quarantined `(key, hlc)` superseded by a newer honest record (R-r3-2); explicit per-record re-admit is a separate action |
| Fold byte-guard breach | `u41:pin-fold-truncated` | fold exceeds `ws13FoldMaxBytes` (newest-first truncation engaged) | a full fold completes within budget (R-r3-3) |

A flap WITHIN an open episode never re-raises (the episode boundary is the dedup
boundary, not the tick).

**E. Pending-pin honesty (offline pinned machine).** Today's shipped contract is
preserved and made honest: a hard pin to an unavailable machine stays QUEUED
(never re-routed — `PlacementExecutor.ts:198-205`), surfaced as `pinState: pending`
with the pinned machine's offline status named. Three brakes: (i) fulfilment on
return requires a SUSTAINED-online window (`ws13SustainedOnlineMs`; a flapping
machine never triggers ping-pong — mirror of U4.4's hysteresis); (ii) a pending pin
older than `ws13PendingPinMaxAgeMs` raises ONE deduped attention item offering
fulfil-or-unpin (covers the decommissioned/rebuilt-machineId case where the old id
never returns); (iii) pin-driven transfers of a topic with a LIVE autonomous run
defer indefinitely as `pending` with that same attention escape — the reconciler's
safe-point deadline override does NOT apply to pin-driven moves, and the consent
gate is never auto-confirmed or retried in a loop.

*Owner-side offline-target gate (fixes defect 7) (R-r2-2).* The same
sustained-online window gates the OWNER side, not just placement: **Case-A
cooperative-transfer initiation** (`OwnershipReconciler.ts:~309-326`) AND **adopt
actuation** (the §2D pin-seeded `PlacementExecutor.decide()` placement of a new
topic, and any other pin-driven actuation whose target is another machine) proceed
ONLY when the pin target has been sustained-online per `ws13SustainedOnlineMs` — the known-and-online
filter that today protects only ADVISORY pins in `effectivePins()` is extended to
LOCAL pins at the point of actuation. When the target fails the gate, NO transfer is
initiated (so the N4 abort churn loop — transfer → target never claims → abort at
`transferDeadlineMs` (120s) → re-observe next tick, every ~2.5min forever — cannot
start), the pin surfaces as `pinState: pending` with the target's offline status
named, and the aged-pending attention item (brake ii above) covers this owner-side
case identically. The `replay-is-bounded-and-paced` test is EXTENDED to cover it:
an offline pinned target across many ticks produces zero transfer/abort cycles and
one `pending` state.

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
(known + online machine, charset-clamped machine id, HLC order, tombstone respect,
and now the §2C skew gate) — never from a name in the record. `pinnedBy` is
serve-time length-clamped on the Bearer-gated read surface.

### 2.G Config knobs — full key paths and defaults (R-r2-5)

All knobs live in the existing `multiMachine.seamlessness` family (the ws13 home,
`src/commands/server.ts:17050`). Frontloaded here — named keys, named defaults, no
tuning decision left open:

| Knob | Config key | Default | Grounding |
|---|---|---|---|
| Reconciler tick cadence | `multiMachine.seamlessness.ws13TickMs` | 30000 (floor 5000) | exists today (`server.ts:17130`) |
| Pin-stability debounce | `multiMachine.seamlessness.ws13DebounceMs` | 30000 | exposes the reconciler's existing `debounceMs` dep (`DEFAULT_DEBOUNCE_MS`, `OwnershipReconciler.ts:145`); the draft's `pinStableMs` name was WRONG — no such knob exists |
| Transfer deadline (N4 abort) | `multiMachine.seamlessness.ws13TransferDeadlineMs` | 120000 | exposes the existing `transferDeadlineMs` dep (`DEFAULT_TRANSFER_DEADLINE_MS`) |
| Sustained-online hysteresis | `multiMachine.seamlessness.ws13SustainedOnlineMs` | 120000 | NEW — 4 reconciler ticks; comfortably above a heartbeat blip and the ~90s hold-policy window; gates §2E fulfilment AND §2E Case-A initiation |
| Pending-pin age bound | `multiMachine.seamlessness.ws13PendingPinMaxAgeMs` | 86400000 (24h) | NEW — drives the `u41:pin-pending-aged` attention item |
| Moves-per-tick cap | `multiMachine.seamlessness.ws13MaxMovesPerTick` | 2 | NEW — paces §2D convergence; a lease flap can never trigger a transfer storm |
| Divergence window | `multiMachine.seamlessness.ws13DivergedWindowMs` | 600000 (10min) | NEW — 20 ticks of persistent desired≠actual before `diverged` + its attention item |
| HLC skew clamp | (constructor `maxDriftMs`, clamped) | 300000 (5min; clamp floor 60s / ceiling 15min) | exists today (`clampMaxDriftMs`, `HybridLogicalClock.ts:113-134`) — the §2C gate reuses it, no new key |
| Fold byte-guard | `multiMachine.seamlessness.ws13FoldMaxBytes` | 67108864 (64MB) | NEW (R-r3-3) — on breach the fold truncates newest-first and raises the `u41:pin-fold-truncated` item; never a silent truncation |

## 3. Multi-machine posture (mandatory)

- **Pin record:** REPLICATED via the existing `topic-pin-record` advisory stream
  (envelope-validated, HLC-ordered, receive-clamped, tombstone-respecting, and
  skew-gated per §2C). The replicated copy remains ADVISORY per the store's
  documented C1/AD4/LA1 posture: it can trigger only cooperative convergence
  through the reconciler — never a force-claim, never a direct write to a peer's
  authoritative local store.
- **Conflict rule:** HLC-highest-wins via the existing `compareHlc`
  (physical→logical→node) — NEVER wall-clock `pinnedAt`, which is display/audit
  metadata only. The rule is sound ONLY behind the §2C skew gate: a future-skewed
  stamp is quarantined — stickily, durable across clock progress (R-r3-2) — before
  it can enter the comparison (R-r2-1). Divergence is
  surfaced two ways: `pinState: diverged` on the placement read, and a daily G1
  coherence-audit line item checking the local-vs-replicated pin agreement
  invariant (the Cross-Store Coherence standard's declared-invariant requirement
  for the two stores answering "where is topic N pinned?").
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
`future-skewed-pin-hlc-is-quarantined-never-merged-never-immortal` (R-r2-1 — a
record past the `maxDriftMs` clamp is excluded from the fold, quarantined on disk,
raises the deduped item, and cannot beat a tombstone);
`skew-quarantine-is-sticky-across-clock-advance` (R-r3-2/R-r4-1 — the exclusion
HOLDS after the clock advances past the skew delta AND after an operator ack
followed by a clock advance (the ack-then-clock-advance arm): the record never
un-quarantines and never beats a tombstone or re-pin minted during the quarantine
window; only a newer honest record or the explicit per-record re-admit clears it);
`skewed-pin-record-is-accepted-at-applier-stream-never-suspect-halted` (R-r3-1 —
a misclocked record persists at the applier, the peer's `topic-pin-record` stream
stays live, and tombstones behind it keep flowing);
`fold-byte-guard-truncates-newest-first-and-escalates-loudly` (R-r3-3 — breach
raises the `u41:pin-fold-truncated` item naming the unfolded ranges; never silent);
`corrupt-pin-store-quarantines-loudly-never-wipes`;
`pending-pin-fulfilment-requires-sustained-online`;
`case-a-transfer-not-initiated-toward-offline-target` (R-r2-2 — local pin to an
offline machine: zero transfer/abort cycles, `pinState: pending`);
`pin-driven-move-defers-on-live-autonomous-run-no-deadline-override`;
`replay-is-bounded-and-paced` (extended per §2E: covers the offline-pinned-target
churn case — many ticks, zero N4 abort cycles; R-r2-2);
`pin-mutation-stamps-one-hlc-on-both-local-set-and-journal-emit` (R-r2 — the
routes.ts:13391 gap);
`pinnedBy-resolves-operator-binding-else-agent-kind`.
Integration: `lease-acquisition-triggers-one-reconciler-tick` (epoch-fenced — a
stale router's tick initiates nothing); `placement-read-reports-actuated-vs-pending-vs-diverged`
(and tolerates the reserved `suspended-pending-owner-return` value; R-r2, renamed
R-r3-4);
`aged-pending-pin-raises-one-deduped-attention-item` (covers BOTH the placement-side
and the owner-side Case-A pending; R-r2-2); `topic-pin-record-stream-is-answer-complete`
(satisfied by the §2C fold design: >500 pin events + rotation, own AND peer-replica
streams, the fold — not the clamped tail read — returns the winning record for a
long-untouched topic; R-r2-3, replica coverage R-r3-3);
`incremental-tail-is-offset-idempotent` (re-scan of unchanged bytes is a no-op;
rotation resets the offset safely; R-r2-3);
`quota-blocked-pinned-machine-still-wins-flagged` (reaffirms shipped semantics);
wiring-integrity: reconciler's pinStore/replicated-store deps non-null and delegating
(the store's own 2026-06-30 always-null wiring death), and the guardManifest entries
carry `criticalPath` + `soakWindowDays` + `declaredLoadBearingAt` with
`expectRuntime` matching the built registration (R-r2).
E2E (feature-alive): pin on A → lease moves to B → B's acquisition tick converges →
placement read shows `actuated` on A — the full loop against real stores.

**Tier 4 — Live-User-Channel Proof (user-role) (R-r2-6).** Pinning is
operator-facing ("run this on the mini" over Telegram; the dashboard Machines tab),
so per the Live-User-Channel Proof standard it is NOT "done" until a user-role
session has driven it end-to-end through the REAL surfaces, BEFORE the operator is
ever asked to test. Harness: test-as-self (Playwright acting as the operator on his
real Telegram Web — the default Playwright profile is already logged in, verified
2026-06-27), recording a signed PASS/FAIL scenario matrix; volatile scenarios run
against demo topics, never the live operator channel. Required scenarios:

1. **Happy path:** send "run this on the mini" in a test topic via real Telegram →
   the pin lands (`pinnedBy: operator`), the conversational reply names the pin,
   and `GET /pool/placement` shows the pin with `pinState: actuated`.
2. **Lifecycle:** force a captain/lease flip → the new router's acquisition tick
   converges → the placement read STILL shows `actuated` on the pinned machine
   (the headline evaporation bug, proven through the user surface). Then unpin via
   Telegram → tombstone emitted, placement read shows unpinned, and a stale
   replicated PUT does not resurrect it.
3. **Failure — offline pinned machine:** pin to an offline/demo machine → the reply
   and the placement read honestly show `pinState: pending` with the machine's
   offline status named; the journal/reap-log show ZERO transfer/abort churn cycles
   (R-r2-2); with the age bound clock-shortened in test config, the ONE
   `u41:pin-pending-aged` attention item appears (and only one).
4. **Channel parity:** the dashboard Machines tab renders the same pin +
   `pinState` the API reports.

The completion gate refuses "done" on this feature without that recorded matrix.

## 5. Rollback / rollout

No new flag. The ws13 family graduates per §2A ladder with the G3 load-bearing
classification making a stalled soak LOUD. Rollback = re-darken the ws13 flags
(existing levers); tombstones, the skew gate, and quarantine hardening are strict
bug-fixes that remain (they change no placement behavior when dark).

**Durable rollback — the migrator must not undo the lever (R-r2-4).** Today the
rollback lever is mechanically undone for `ws13Reconcile`:
`migrateConfigSeamlessnessDevGate` strips ANY explicit `ws13Reconcile: false` on
every `PostUpdateMigrator` run (`SEAMLESSNESS_DEV_GATED_FLAGS`,
`PostUpdateMigrator.ts:397-399`, applied at `:426-432` and invoked at `:8404`) —
it cannot distinguish an operator-set `false` from a default-shaped `false`, so an
operator's re-darken silently reverts to the dev-gate resolution on the next
update. (`ws13PinReplicate` is NOT in the strip list — the asymmetry is noted; it
must never be added.) The named durable path, decided: **the graduation PR removes
`'ws13Reconcile'` from `SEAMLESSNESS_DEV_GATED_FLAGS`** — the moment the flag
flips to a fleet default, an explicit `false` becomes an operator darken and the
migration must respect it. Until graduation the strip is correct behavior (a
default-shaped `false` should resolve through the dev gate); after graduation it
would be the migrator overriding the operator, which is why the removal ships IN
the graduation PR, not later. (The alternative — a separate operator-darken key
the migration respects — was considered and rejected: two keys answering "is ws13
on?" is a new Cross-Store Coherence hazard for no gain.)

Re-enable after a long dark period cannot replay ancient intent: tombstones + the
answer-complete fold (skew-gated) keep the record set current, and the
aged-pending-pin attention item (not a silent move) is the path for any pin older
than its bound.

## Frontloaded Decisions

1. **Graduate + harden WS1.3; build nothing parallel.** One store family, one
   convergence engine (the reconciler), one gate family (`ws13*`). The draft's new
   record shape/gate/replay-actor are withdrawn.
2. **Quota-blind hard-pin stays** (deliberate shipped semantics; peer-asserted
   quotaState never evicts operator intent).
3. **HLC-highest-wins is the only conflict rule**; `pinnedAt` is display-only —
   and the rule is skew-gated: a record HLC past the clamped `maxDriftMs` is
   quarantined loudly, never merged, never immortal (R-r2-1). The exclusion acts
   ONLY at the fold — the applier accepts-and-persists a skewed record, because
   its sole refusal path would suspect-halt the peer's whole stream (R-r3-1) —
   and the quarantine is STICKY: a durable `(key, hlc)` set beside the pin store,
   immune to clock progress; ack closes the notification only — self-clearing is
   supersession by a newer honest record, and re-admission is a separate explicit
   per-record action (R-r3-2/R-r4-1).
4. **pinnedBy is local-only provenance** ({operator|agent} domain from the verified
   topic-operator binding; replicated record stays non-PII).
5. **Pending-pin: queued-never-rerouted preserved**, with sustained-online
   fulfilment hysteresis, a bounded-age attention escape, and consent-gate deference
   (no deadline override for pin-driven moves) — and the SAME sustained-online gate
   applies to owner-side Case-A transfer initiation, so an offline pinned target
   yields `pending`, never a silent 2.5-minute transfer/abort churn loop (R-r2-2).
6. **Corrupt store quarantines loudly; journal stream answer-complete** — storage
   via `rotateKeep: 0` AND read via the boot-time full-stream fold (dedicated
   unclamped fold path over active file + archives, own AND peer-replica streams)
   + offset-tracked incremental tail (TokenLedgerPoller pattern); the
   snapshot-store alternative is rejected (R-r2-3). Both are correctness fixes to
   the foundation, in scope here. The fold's honest bound is total retained
   record bytes (no compaction mechanism exists), argued small by the operator
   event rate and backstopped by the loud newest-first `ws13FoldMaxBytes`
   byte-guard — never a silent truncation; per-key rewrite-compaction at rotation
   is the tracked follow-up <!-- tracked: CMT-1875 --> (R-r3-3).
7. **Actuation verification is part of the feature** (pinState on the placement
   read + G1 agreement-invariant line): a pin without verify-after is a wish.
   `pinState` reserves `suspended-pending-owner-return` for U4.2 (the joint enum
   value, renamed to match U4.2 exactly — R-r3-4; semantics in
   `docs/specs/u4-2-stale-owner-release.md` §2.4); `pinHeldSince` is the winning
   record's HLC physical component (R-r2).
8. **Every knob is named and defaulted in §2.G** — `ws13DebounceMs` (the corrected
   name; `pinStableMs` never existed), `ws13SustainedOnlineMs` 120s,
   `ws13PendingPinMaxAgeMs` 24h, `ws13MaxMovesPerTick` 2, `ws13DivergedWindowMs`
   10min (R-r2-5).
9. **Durable rollback:** the graduation PR removes `ws13Reconcile` from
   `SEAMLESSNESS_DEV_GATED_FLAGS` so an operator's explicit darken survives every
   migrator run; no second darken-key (R-r2-4).
10. **Tier-4 user-role live proof is a completion requirement** (test-as-self over
    real Telegram + dashboard parity; scenario matrix recorded before the operator
    is asked to test) (R-r2-6).

## Open questions

None.
