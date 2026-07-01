---
title: "Reconciler Anti-Oscillation — Closing the Cross-Machine Move Tug-of-War"
slug: "reconciler-single-decider-tugofwar"
author: "echo"
review-convergence: "2026-07-01T01:33:00.463Z"
review-iterations: 4
review-completed-at: "2026-07-01T01:33:00.463Z"
review-report: "../../../../.worktrees/echo-one-decider-guard/docs/specs/reports/reconciler-single-decider-tugofwar-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 3
contested-then-cleared: 2
---

# Reconciler Anti-Oscillation — Closing the Cross-Machine Move Tug-of-War

**Status:** converged (round 4; awaiting operator approval)
**Anchor standard:** Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions
**Rollback flag:** `multiMachine.seamlessness.ws13AntiOscillation` (dev-gated, dryRun-first)
**Related:** `cross-machine-reconciler-convergence.md` (the WS1.3 reconciler this hardens), MULTI-MACHINE-SEAMLESSNESS-SPEC.md

---

## 0. Terminology

- **Topic / conversation** — a chat that lives on exactly one machine at a time; `sessionKey` = its id.
- **Ownership record** — the durable "machine M owns topic K, at **epoch** e" fact, mutated only by a fenced **CAS**. The **epoch** is a monotonic integer bumped on every ownership state change (transfer/claim/abort/force/adopt/release) — the topic's causal clock for **ownership transitions** (skew-proof: it advances only through a CAS).
- **Pin** — a "move topic K to machine P" instruction. A **local pin** is authoritative on the machine that wrote it (router-write-only). An **advisory (replicated) pin** is the read-only copy peers receive.
- **HLC** — a `{physical, logical, node}` timestamp ordering replicated records; `compareHlc` is physical-first (skew-proof only while messages flow; a partitioned machine's physical clock can drift).
- **Reconciler** — a per-machine loop that each tick tries to make ownership match the pins via the FSM handoff `active(owner) → transferring(owner→target) → active(target)`.
- **Epoch fence** — the invariant that a CAS lands only at `epoch+1`; the **sole** authority for exactly-one-owner. Nothing here weakens it.

## 1. Problem (the "fifth finding")

Last night's work fixed the move that *stuck*. The live proof then surfaced a **liveness** defect:
driving a **second move on a conversation already mid-handoff** makes the two machines' reconcilers
issue **competing transfers** and pull ownership back and forth — a tug-of-war. Each handoff is
individually safe (the epoch fence never yields two owners), but the topic never settles. The
operator paraphrased the fix as "only one machine should decide a move at a time." Round 1 + round 2
review showed the oscillation has coupled causes, that a naive per-machine "decider lock" is the
WRONG primitive (host-local — cannot serialize two machines), and that the right fix makes
single-decider behavior *emerge* from causal ordering + a fail-safe brake.

## 2. Root causes (evidence-cited, canonical main v1.3.703)

- **RC1 — Pins are never cleared after a move lands.** `TopicPlacementPinStore.clear()` /
  `buildTopicPinTombstone()` exist but have **zero production callsites** (only `.set()` at
  `routes.ts:13304`, `server.ts:19223`). The stale pin on the **initiating** machine is the
  substrate a second move fights.
- **RC2 — Local pins carry no HLC.** Both `.set()` callsites omit `hlc`
  (`TopicPlacementPinStore.ts:79`) → `deriveLocalPinHlc()` falls back to wall-clock
  (`OwnershipReconciler.ts:188-191`) → `effectivePins()` (`:201-223`) compares a real HLC against a
  wall-clock stamp: the skew class this workstream fixed, reintroduced.
- **RC3 — No consistent ordering of, or serialization of, move *initiation*.** Both reconcilers may
  issue a `transfer` for the same `sessionKey` (`:309-324`); the epoch fence makes each safe but does
  not damp the alternation. Case-B claim ignores the current pin (`:274-281`).
- **RC4 — An update migration erases an operator's deliberate "off".**
  `migrateConfigSeamlessnessDevGate` (`PostUpdateMigrator.ts:411-435`) strips **any** `false`, so
  `ws13Reconcile:false` is deleted → the dev-gate defaults **on** (`devAgentGate.ts:44`). It has run
  every update since 2026-06-13, so an operator's `false` is **already gone** and unrecoverable from
  config — an irreversibility the fix must state honestly.

## 3. Design — five changes (F1–F5)

Round-1/2 lesson: the host-local decider lease was the wrong primitive. The design **uses no lock**;
single-decider behavior emerges from a consistent causal order (F1) over a substrate that clears
itself (F2), backed by a fail-safe churn breaker (F3), with a bounded recovery path (F4) and an
honest migration fix (F5). All *behavioral* changes ship behind `ws13AntiOscillation` (dev-gated,
dryRun-first) EXCEPT the always-on HLC stamping (FD-H2) and F5 (migration correctness).

### F1 — A single, consistent causal order for move-intents
- **(always-on) Stamp every local pin with a real HLC** at both `.set()` callsites, from the same
  `HybridLogicalClock` the replicated emitter uses. On ONE machine the HLC's logical counter
  increments per write, so a user's sequential Move#2-after-Move#1 correctly supersedes Move#1.
- **(flag-gated) Precedence tuple = `(causalSeq, hlc, node)`**, where `causalSeq` = the topic's
  ownership **epoch observed at set-time**. This is a **total order every machine computes
  identically**, which is the load-bearing property: it guarantees **no oscillation in ALL cases**,
  and **mesh-wide convergence whenever the relevant records are mutually visible** (self-healing after
  a partition, and after a rolling deploy completes — §6 notes mixed-version peers can keep the
  tug-of-war alive transiently until every peer upgrades).

**Honest guarantee (round-2 correction).** `causalSeq` orders moves that are separated by an
ownership transition (a move issued *after* a transfer landed carries a higher epoch and dominates,
**regardless of physical clock** — closing the partition+skew case for epoch-separated moves). Two
moves issued against the **same** observed epoch (e.g. Move→B and Move→A both set while B still owns)
**tie** on `causalSeq` and resolve by `(hlc, node)`. That tie is **not** oscillation: because the
tuple is a total order, both machines pick the **same** winner and converge. The only residual is
*which* of two genuinely-concurrent same-epoch moves wins under clock skew — a real
concurrent-move race where "either deterministically wins" is acceptable (you cannot causally order
two operations that observed identical state). We therefore do **not** introduce a new CAS-fenced
per-pin counter (round-2 alternative): it adds a replicated CAS primitive + forge surface for no gain
on the actual goal (no-oscillation + deterministic convergence), which the epoch+HLC total order
already delivers. This scoping is stated so the guarantee is never over-claimed.

**Wire/schema (round-2 HIGH — without this, F1 is unimplemented).** `causalSeq` is added to
`topicPinRecordStoreSchema.knownFields` and to `TopicPin`/`MergedReplicatedPin`, validated on receive
(finite integer ≥ 0, monotonic-nondecreasing), and `mergeUnionToPins`/`effectivePins` order
`causalSeq`-first. It is an **additive OPTIONAL field**: the receive type-clamp must **ignore-not-
reject** an unknown/missing field (allowlist-drop), so an OLD-release peer that emits no `causalSeq`
is not quarantined (forward-compat).

**Absent-`causalSeq` rule (rolling deploy).** When either side of a compare lacks `causalSeq`
(old-release peer), the pair falls through to `(hlc, node)` — i.e. old-peer pins order by HLC
(status-quo), never systematically lose. (Not "absent = lowest," which would misroute every old-peer
move toward new-peer intents.)

**Anti-forge (round-2 security HIGH; round-3 clamp-not-reject; round-4 re-evaluated cap).** The raw
`causalSeq` is stored **as received** (never mutated on ingest, never rejected/dropped, never a
peer-quarantine). Precedence uses an **effective** value computed **at comparison time**:
`effectiveCausalSeq = min(rawCausalSeq, highest ownership epoch the receiver has observed for that
topic)`. A forged forward epoch is *provably fabricated* (the epoch advances only via fenced CAS), so
the `min` strips the fabricated forward-rank — the pin still competes at the current epoch by
`(hlc, node)`, and can never mint an owner (the epoch-fenced CAS remains sole arbiter). Because the
cap is **re-evaluated each comparison against the CURRENT observed epoch**, a *legitimately*
replication-lagged move (a real move at epoch N+1 whose advisory arrives before the receiver observes
the N+1 bump) has its effective rank **lift automatically** the moment the ownership record catches
up — with **no dependence on a re-emit being reprocessed** (closing the round-4 same-key-idempotency
gap: even if the periodic re-emit is deduped, the stored raw `causalSeq` is re-capped against the now-
higher observed epoch). This preserves Deferral=Deletion (the pin is never dropped) AND forge-safety.
**Unknown/never-observed epoch** (a fresh/rejoined machine) ⇒ observed treated as **0** ⇒ effective 0
(orders by `(hlc, node)`; a topic with no locally-observed owner can't drive a Case-A transfer
anyway). A later real ownership transition carries a higher epoch and dominates, so a capped pin can
never permanently mis-win.

### F2 — Clear the LOCAL pin on the WRITING machine; retire the advisory by *source-liveness*, not a timer
Round 1 fixed *where* the clear fires (on the machine that **wrote** the pin, not the target). Round 2
fixed *how the advisory is retired* to avoid **Deferral=Deletion**:
- Clear is performed by the machine holding a **local pin** for a topic it observes **converged**
  (`owner==pin.preferredMachine && active`), **debounced and epoch-stable**, on its **own** store only
  (§5.1 preserves the router-write-only invariant). One **shared helper** covers BOTH the
  reconciler-converged path and the imperative `/pool/transfer` path (FD-OQ2).
- **No mesh tombstone** (kills the clear-vs-set freeze race). The advisory replicated copy is retired
  by the source: the machine holding the source local pin **keeps the advisory alive** (re-emits on
  the replication cadence) **while the pin is set AND the topic is unconverged**, and stops
  re-emitting once it clears the pin at convergence — so a **slow/offline/busy owner's still-pending
  move is never decayed out from under it** (round-2 lessons-aware/codex). Retention is a *backstop*
  bound (§6) sized strictly greater than the max convergence deadline + partition-heal time, not the
  primary retirement trigger. A genuinely new move is always a fresh `.set()` whose higher
  `causalSeq`/HLC dominates any lingering advisory.
- **Re-emit semantics (round-3 codex).** The re-emit is the SAME replicated pin record on the SAME
  `sessionKey` idempotency key (a periodic refresh of an unchanged record, deduped by key), NOT a new
  intent — so it changes the prior "emit only on user mutation" cadence assumption from
  *mutation-only* to *mutation-plus-liveness-refresh-while-pending*, bounded: it fires only while a
  local pin is set AND unconverged (≈ 0–1 topics at a time), at the existing replication cadence,
  under the store's existing per-kind rate cap — no unbounded traffic. State this explicitly so the
  invariant change is intentional, not a silent regression. **P19 brake (No Unbounded Loops):** the
  re-emit has a HARD ceiling = the retention backstop age (> `transferDeadlineMs` + partition-heal).
  A move that has not converged by then stops re-emitting AND surfaces ONCE as "move could not
  complete" (a loud terminal stop, deduped) — the loop can never run forever; a permanently-offline
  target yields a bounded, surfaced give-up, not an eternal refresh.
- **Zombie-advisory retirement (round-3 adversarial).** An advisory whose `causalSeq` is **below the
  current ownership epoch** is retired once a post-convergence ownership transition has occurred — so
  a system-auto-cleared advisory can't re-attract ownership across a later epoch bump (e.g. a
  recovered dead target being pulled back by its own stale lingering advisory after the operator's
  move already settled elsewhere). (Clarity: the **local pin is authoritative and is NEVER
  zombie-retired** — retirement acts on the *replicated advisory copy* only — so an owner-initiated
  transfer, which reads the owner's local pin, is unaffected; a below-epoch advisory being re-retired
  on peers after an abort bumps the epoch IS the intended recovered-dead-target stability behavior,
  not a lost move.)

### F3 — Fail-safe churn breaker (P19), and single-decider *behavior* without a lock
Single-decider behavior emerges from: (1) only the owner initiates (existing Case A); (2) one
consistent effective pin mesh-wide (F1+F2) → the owner transfers once toward one target; (3) a
**per-topic transfer-churn breaker** (P19 — No Unbounded Loops):
- **Count** the journaled `emitPlacement(..., 'reconcile-transfer')` entries emitted once per
  completed reconciler transfer (the placement pairing on the reconciler's `transfer` action in
  `OwnershipReconciler.act`; cardinality is **one entry per full `active→transferring→active`
  transfer**, NOT raw epoch deltas, which over-count — one transfer = two epoch bumps). The unit
  test asserts one full transfer produces exactly one counted entry. Count over a **local-monotonic**
  time window, held in a **bounded per-topic in-memory ring** of recent transfer timestamps, keyed
  per topic and pruned when the topic is closed/reaped (ring lifecycle = topic lifecycle). This is
  **per-machine-observed** (each machine derives its own from its journal view — not "mesh-visible";
  a partitioned machine may undercount and trip late, which is the fail-safe direction). No new
  durable store.
- **On trip:** drive **ONE final convergence** — a **single** transfer CAS attempt toward the
  current highest-precedence effective pin (one attempt, NOT retry-until-success; if the CAS is lost
  it is simply not retried) — **then** halt initiation for that topic for the window, so the breaker
  never strands a topic on the wrong (merely last-CAS-winner) machine. Because the window (~10min) ≫
  replication latency, views have converged by trip time, so the one attempt targets the true mesh
  winner. Surface ONE "topic thrashing" signal via the
  tone-gated `/attention` surface carrying **requested-vs-settled** target (Observable Intelligence;
  this is also the effectiveness metric the conformance gate required).
- **Fail-SAFE:** halts *initiation* only; the current owner keeps serving (never a freeze). Recovery/
  completion CAS moves (claim, F4) are never breaker-gated. **Close-the-Loop:** the thrashing
  attention item is auto-cleared when the breaker re-arms, so the operator learns it settled.
- **Bounds:** default 5 transfers / 10-minute window per topic; tunable. Gemini/round-2: this
  prioritizes stability over liveness for a *legitimately* fast operator re-pin sequence — an
  accepted, documented cost (a paused move, never a lost or frozen one).

### F4 — Recovery for a dead handoff, with a full state table
Round-2: the abort branch was not FSM-expressible and could snatch a merely-slow target. Corrected —
F4 acts only when **BOTH owner AND target are provably dead** (offline past `deathEvidenceMs`,
in-quorum), and follows the explicit state table for a `transferring(source→target)` record (a
reachable-but-slow machine is NEVER acted against — the same discipline the existing force-claim uses
for owners):

| source | target | action |
|---|---|---|
| alive | any | not F4 — the owner's own Case A / abort-transfer handles it |
| dead | alive **and is the pinned target** | target claims via the existing `transferring→claim`; F4 idle |
| dead | alive, not the pinned target | leave to normal reconcile (no steal) |
| dead | dead, **pinned target reachable elsewhere** | force-claim to the reachable **pinned** target only |
| dead | dead, pinned target also dead | force-claim (adopt) to a **reachable in-quorum** machine selected by the **existing force-claim adopter rule** (else deterministic lowest node-id among reachable in-quorum) so the conversation stays served — **never** to an arbitrary bystander, **never** abort to the dead source (a dead owner cannot serve). The epoch fence collapses any concurrent adopts to one owner (the loser re-reads), so a divergent reachability view cannot split-brain. |
| dead | dead, none reachable / no quorum | fail-safe-stuck — heals via the epoch fence when a machine returns |

- **N=2 (the real laptop↔Mini topology):** death evidence is **not** satisfiable by a lone
  partitioned survivor. A machine merely *partitioned from* its peer (not outliving it) does NOT get
  death evidence; the 2-machine pool proceeds against a peer only when it is **provably dark** (offline
  past `deathEvidenceMs`) — a plain partition is fail-safe-stuck and heals via the epoch fence, never
  a survivor-steal of a live conversation.
- **Knobs:** `transferDeadlineMs` default 60s (tunable); `deathEvidenceMs` is the existing force-claim
  bound (180s). F4 requires *past `deathEvidenceMs`* for both source and target — so a target offline
  only 60–180s is never snatched.

### F5 — Retire the intent-erasing strip; make the switch honest
Round 2: the provenance-marker mechanism was not retroactively implementable (an OMITTED dev-gated
flag never has a default written, so there is no marker; the five existing flags' on-disk `false` are
unmarked and byte-identical to operator intent). The correct, simpler fix:
- **Retire the strip loop entirely** (`migrateConfigSeamlessnessDevGate` no longer deletes a `false`
  for any seamlessness flag). Rationale: the strip's GC purpose (removing default-shaped `false` so a
  dev agent resolves live-on-dev) is **already fulfilled fleet-wide** — it has run idempotently since
  2026-06-13, so no default-shaped `false` remains to collect; keeping it running now only risks
  **eating future operator intent**. An operator's explicit `false` must win over auto-GC convenience.
  Failure direction is now safe: a hypothetical leftover default `false` resolves the feature **dark**
  (recoverable by removing the key), never silently **on**.
- **Wiring:** register `ws13AntiOscillation` in `DEV_GATED_FEATURES` (`devGatedFeatures.ts` — required
  for the both-sides wiring test + dark-gate lint) and OMIT it from `ConfigDefaults` (the dev-gate
  resolves it). It is *not* added to any strip list (there is none anymore).
- **Existing-test cleanup (round-3 integration — Zero-Failure).** Retiring the strip loop turns the
  existing `tests/unit/PostUpdateMigrator-seamlessnessDevGate.test.ts` (10 cases asserting the strip
  *deletes* a default-shaped `false`) red, and leaves a now-false `result.upgraded.push("stripped
  default-shaped …")` log line at the `migrateConfigSeamlessnessDevGate` call-site
  (`PostUpdateMigrator.ts:~7983`). The build MUST: delete/rewrite that test suite to assert the new
  no-strip behavior (an operator `false` survives; nothing is deleted), and remove the call-site's
  strip invocation + its `upgraded.push` line. This is called out so the change lands green (no
  "pre-existing failure").
- **New tunables are code-defaulted** (round-3 integration): the breaker bounds (5/10min),
  `transferDeadlineMs` (60s), retention keep-latest-N (default 8) + age backstop, and the reconciler
  behavior all reach existing agents via **nullish code-level fallbacks** (like the sibling
  `ws13DryRun` default) — NOT via a `ConfigDefaults` literal (which would inject a dark
  `enabled:false`-shaped default the dark-gate lint would flag). The `causalSeq` schema field is
  additive-optional (no ConfigDefaults entry, no schema-version migration).
- **Irreversibility (honest):** an operator whose `ws13Reconcile:false` was already stripped cannot
  have intent restored from config and **cannot be detected per-agent** (indistinguishable from
  never-set). Retro-notifying every gate-default dev agent would fire for agents that never set an
  off (false positives). So the recovery is a **one-time release-note heads-up** (not a per-agent
  Attention item), plus the guard-posture surfacing below. This is stated as an accepted, bounded
  limitation (Close-the-Loop within what's honestly knowable).
- **Guard-posture surfacing:** a seamlessness flag resolving to a non-default posture is made visible
  on the existing guard-posture readout so an operator can see and re-assert it.
- **Agent awareness (Migration Parity):** add the one-line reconciler-posture note to
  `generateClaudeMd()` (`src/scaffold/templates.ts`, so NEW agents get it via `init`) AND add a
  content-sniffed insertion in `migrateClaudeMd()` (idempotent, guarded on the note's absence, so
  EXISTING agents get it on update) — per the Migration Parity Standard; a template-only change would
  never reach deployed agents.

## 4. Dependencies between the changes
**F2 depends on F1** (they share the flag): retiring an advisory is only safe if a genuine re-pin
causally dominates a lingering advisory, which requires F1's `causalSeq`/HLC ordering in the merge.
F1's always-on HLC stamping ships unconditionally; F1's causal-precedence, F2, F3, F4 are flag-gated
together. F5 is a standalone correctness fix. The headline ask ("one decider") is delivered by
F1+F2+F3 *behavior*, not a lock.

## 5. Safety analysis
- **Exactly-one-owner:** unchanged — the epoch-fenced CAS is the sole arbiter; F3 only *reduces*
  initiations; F1 changes *ordering*, never ownership.
- **No oscillation:** F1's total order makes every machine converge on the same winner deterministically.
- **No new freeze:** F2 emits no tombstone; F3 halts initiation but never ownership and drives one
  final convergence first; F4 closes the dead-owner/dead-target hole and never acts on a slow machine.
- **No lost move (Deferral=Deletion):** F2's advisory lives while its source pin is set+unconverged;
  retention backstop > max convergence deadline; a past-safe-point slow move is never decayed out.
- **Partition + skew:** F1 dominates across epoch boundaries by construction; within a same-epoch
  concurrent race it converges deterministically (honest scoping in §F1). A partitioned setter cannot
  mint a dominating intent until it observes current state — an inherent, self-healing causal property,
  documented (not a silent inversion).
- **Skew-proof debounce & breaker windows:** computed from local-monotonic timestamps, never a peer's
  wall-clock field.
- **Signal vs Authority (verified):** no blocking authority is introduced; causal ordering and the
  breaker are liveness mechanisms subordinate to the epoch fence.

### 5.1 Provenance / own-store-writer invariant
F2 makes the reconciler an **audited second writer of its OWN pin store** for the narrow, debounced,
epoch-stable **clear** only (never a `set`, never a peer's store, never triggered by peer-supplied
data beyond the fenced ownership record). The invariant text (`OwnershipReconciler.ts:26-29`) is
updated to admit this; every reconciler-originated clear is audit-logged; the clear fires only on a
stable converged read.

## 6. Multi-machine posture (mandatory declaration)
| Surface | Posture |
|---|---|
| Ownership record / epoch | replicated (existing CAS + journal) — the causal arbiter |
| Local pin (`TopicPlacementPinStore`, +`causalSeq`) | machine-local, router-write-only; F2 clear acts only on own store |
| Advisory replicated pin (+`causalSeq`, additive-optional) | proxied-on-read; retired by source-liveness (re-emit while source pin set+unconverged) + retention backstop; NO tombstone |
| Transfer-churn breaker window | per-machine-observed, in-memory ring from the local journal view (not replicated) |
| Effectiveness metrics (oscillations-halted, pin-clears, causal-overrides) | **persisted** (durable counters; the conformance gate reads cumulative, not session-reset) |
| Reconciler/breaker status readout | machine-local read, Bearer-authed (existing `/reconciler` route); machine/topic ids only |

**Retention (bounds `mergeUnionToPins`):** a **hard per-topic cap** (keep-latest-N advisory entries by
`causalSeq`) enforced by an **active prune** (not lazy-on-read), *plus* an age backstop >
`transferDeadlineMs` + partition-heal — both tied to real config keys. Pin-store reads on the tick
path are **memory-served** (no per-tick disk read now that the lease is gone).

**Rolling-deploy / backward-compat:** during a staggered deploy an OLD peer still issues competing
transfers, never clears pins, and stamps wall-clock HLCs — so the tug-of-war can persist until every
peer upgrades; fail-safe (breaker + no-tombstone + F1 total order) keeps it from corrupting or
freezing anything. The new `causalSeq` field is additive-optional (old peers ignore it; the compare
falls through to HLC — §F1 absent rule). A forward-compat test asserts an old peer receiving an
augmented pin ignores the field and orders by HLC.

## 7. Observability
Extend `OwnershipReconciler.status()` / `explainTopic()` and the `/reconciler` route with per-topic
churn count + window, breaker state (armed/tripped + when + requested-vs-settled), and **persisted
cumulative effectiveness metrics** (oscillations-halted, pin-clears, causal-precedence-overrides) so
the fix is auditable and gradable. The "thrashing" trip surfaces once (deduped) and is cleared on
re-arm.

## 8. Frontloaded Decisions
- **FD-OQ1 (RC4 fix):** **retire the strip loop** (do not delete an operator `false` for any
  seamlessness flag); the new flag is never added to any strip list; already-stripped intent is
  unrecoverable/undetectable → one-time release-note heads-up + guard-posture surfacing (no noisy
  per-agent notice).
- **FD-OQ2 (clear site):** **both** the reconciler-converged branch and `/pool/transfer`, via one
  shared helper.
- **FD-OQ3 (decider substrate):** **no lock** — single-decider behavior emerges from F1+F2+F3.
- **FD-H2 (HLC stamping):** **always-on**, not flag-gated. Only F1's causal-precedence, F2, F3, F4 are
  flag-gated.
- **FD-causalSeq (representation):** the topic's ownership **epoch observed at set-time**; a new
  CAS-fenced per-pin counter is explicitly rejected (§F1) — the epoch+HLC total order already delivers
  no-oscillation + deterministic convergence.
- **FD-absent-causalSeq:** a compare where either side lacks `causalSeq` falls through to `(hlc, node)`
  (old-peer rule), never "lowest".
- **FD-breaker (count/window/bounds):** count journaled `reconcile-transfer` entries over a
  local-monotonic window (default 5/10min, tunable); trip drives one final convergence then halts;
  clears on re-arm.
- **FD-transferDeadlineMs:** default 60s (tunable); F4 requires both source and target past
  `deathEvidenceMs` (180s).
- **FD-decay:** advisory retires on source-pin clear/convergence; retention backstop = age >
  `transferDeadlineMs` + partition-heal AND a hard keep-latest-N cap (concrete config keys, actively
  pruned).

## 9. Test plan (Testing Integrity Standard — all three tiers, real two-machine topology)
The reconciler harness already runs the real two-machine topology (separate stores joined only by the
journal). All new tests use it.
- **Unit (F1):** `causalSeq` added to schema + validated; a fresh re-pin dominates a lingering advisory
  via `causalSeq`; two same-epoch concurrent re-pins converge to the SAME deterministic winner on both
  machines (no oscillation) — asserted BOTH machines agree; an epoch-separated move dominates
  regardless of a skewed clock; a forged forward `causalSeq` (> observed epoch) is CLAMPED (pin
  survives, orders by `(hlc,node)`, never dropped, never peer-quarantined) and re-validates after F2
  re-emit; unknown-epoch clamps to 0; an old-peer pin with no `causalSeq` orders by HLC (not lost).
- **Unit (F2):** clear fires on the WRITING machine at debounced epoch-stable convergence, own store
  only; a mid-flap transient does NOT clear; no tombstone emitted; a slow/offline owner's still-pending
  advisory is re-emitted and NOT decayed out; a stale advisory after convergence cannot trigger a
  transfer.
- **Unit (F3):** breaker counts journaled transfers (not epoch deltas) and trips at the bound; on trip
  it drives one final convergence toward the highest-precedence pin THEN halts (never strands on the
  wrong machine); surfaces once with requested-vs-settled; clears on re-arm; a single legitimate move
  never trips; a partitioned machine's undercount trips late (fail-safe) but still converges on heal.
- **Unit (F4):** the full state table — dead source + dead target → force-claim to the reachable pinned
  target; both-dead-pinned-unreachable → adopt to highest-precedence reachable, never a bystander,
  never abort to a dead source; a target offline 60–180s is NEVER snatched; N=2 partition is
  fail-safe-stuck, not survivor-steal.
- **Unit (F5):** REWRITE `PostUpdateMigrator-seamlessnessDevGate.test.ts` — the strip loop no longer
  deletes an operator `false` (all six flags survive an update pass); the old "strip deletes a
  default-shaped false" assertions are removed and the call-site's `upgraded.push` line is gone (green
  build, no pre-existing failure); `ws13AntiOscillation` is registered in DEV_GATED_FEATURES and
  omitted from ConfigDefaults (both-sides wiring test); guard-posture shows a non-default seamlessness
  flag.
- **Unit (negative interactions — round-3 gemini):** F4 recovery still functions correctly when F3's
  breaker is tripped for the same topic (F4/claim/abort are never breaker-gated); the anti-forge clamp
  under a lagged epoch view keeps the pin (clamps, never drops) and re-validates after F2 re-emit.
- **The tug-of-war regression:** the exact Section-2 interleaving (Move #1 converges → Move #2 re-pins
  mid-life) settles to a single stable owner within N ticks with the bundle ON, and reproduces the
  oscillation with it OFF (the test must bite).
- **Integration:** a real re-pin-mid-transfer round-trips through the actual replication log and
  converges once; the `/reconciler` route reports breaker + persisted effectiveness metrics (real when
  on, clean "not active" when off, rejects unauthenticated); a forward-compat mixed-version merge (old
  peer receives an augmented pin, ignores `causalSeq`).
- **E2E / feature-alive:** boot a real server with the flag on; the status surface returns real data
  (not 503); the F5 migration change is exercised by a real update pass (operator `false` survives).

## 10. Rollback
`ws13AntiOscillation` (dev-gated, dryRun-first): dryRun logs intended pin-clears / breaker-trips /
causal overrides / F4 recoveries without acting. Always-on HLC stamping (FD-H2) and F5 (migration
correctness) ship unconditionally. Single-machine pools: strict no-op (the reconciler returns before
any machinery when fewer than 2 machines are registered).

## Frontloaded Decisions — resolution note

All decisions are resolved into §8 (Frontloaded Decisions). See §8.

## Open questions
*(none)*
