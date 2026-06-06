# Side-Effects Review — Working-set trigger + reflex + drain + visibility guard (P2.2b)

**Version / slug:** `working-set-trigger-p22b`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (implements §3.3/§3.4/§3.6 of the 4-round-converged spec; everything rides the explicit replication gate; e2e proves the EXO case end-to-end)`

## Summary of the change

P2.2b — the working-set transfer now FIRES. Completes P2:

1. `src/core/WorkingSetPullCoordinator.ts` — the orchestration layer: the
   move trigger (receiver-side deliverMessage onAccepted seam), the reflex,
   and the returning-peer staggered drain share ONE pipeline. Durable
   (topic,epoch) op-key dedupe (restart-proof, `pull-opkeys.json`, bounded
   window 200); skips not-owner / placing-confirm / prevOwner-self;
   single-flight per topic; plural bounded nomination from journal evidence
   (own + replicas, cap 3, cappedNominees named); pending-pulls filed with
   busy-never-burns-an-attempt accounting; staggered drain (rearmConcurrency
   1) with stale-owner clear + epoch supersession; slow sweep tick = TTL +
   live-source re-arm.
2. `src/core/PeerVisibilityGuard.ts` — §3.6 rider: pure
   `detectImproperRevocations` (NOT inside loadRegistry — it stays hot +
   pure) + cross-boot-deduped notices (keyed on revokedAt); 30-min-grace
   disappearance notice naming stranded pending-pull topics; flap bound
   (3 episodes/24h → ONE collapse notice). All notices ride the
   agent-health attention lane.
3. `POST /coherence/fetch-working-set` (routes.ts) — the reflex. 503 dark,
   400 bad topic, 429 rate-limited, 200 outcome.
4. `PeerPresencePuller.onPeerRecorded` seam — the §3.4 re-arm rides the
   SAME 30s cadence journal-sync does (no new polling loop).
5. server.ts wiring: coordinator + ledger + guard constructed ONLY when the
   serve side exists (the explicit `replication.enabled === true` gate);
   onAccepted hook fires BEFORE the session-pool stage gate
   (fire-and-forget; the coordinator carries its own gates); ledger
   onCorrupt/onExpired → agent-health attention items; 10-min sweep timer;
   5-min guard timer.
6. Agent Awareness + Migration Parity: CLAUDE.md template gains the
   fetch-reflex section with the proactive trigger ("user references
   files/work not on this machine"); `migrateClaudeMd` adds it
   content-sniffed for existing agents.
7. State-Coherence Registry: `pull-opkeys` + `visibility-guard` categories.

## Decision-point inventory

- **Trigger gates** (ordered): single-flight → ownership (live store, the
  only authority) → epoch present → op-key dedupe (move only; the reflex
  deliberately bypasses it — an explicit ask re-fetches) → prevOwner-self
  skip → pressure defer (op-key NOT recorded, so the next accept
  re-triggers — a defer is never a silent drop).
- **busy vs attempts**: only genuine failures (unreachable/throw) reach
  `recordAttempt`; busyExhausted re-files the record attempt-free (§3.2).
- **Drain semantics**: per-record ownership recheck (stale-owner → clear,
  newer epoch → supersede) so a drained record can never write onto a
  topic this machine no longer owns.
- **Guard honesty**: hygiene signal only — populated revocation fields are
  NOT authenticated; the notice text says so explicitly.

## 1. Over-block

A reflex call within 30s of the last is 429'd (coalescing handles the
concurrent case). A move while under host pressure defers the pull until
the next trigger. The drain clears records for topics we no longer own —
deliberate: the current owner's own pull covers truth.

## 2. Under-block

The op-key window is bounded at 200 — a topic moved 200+ epochs ago could
re-pull (idempotent via skippedExisting, harmless). The disappearance
notice depends on the pool registry's online view (a registry blind spot
is the §3.6 known limitation). The pressure-defer relies on the next
accept/reflex; a topic that never gets another message AND was deferred
falls to the reflex (named spec §3.3 behavior).

## 3. Level-of-abstraction fit

The coordinator is transport-agnostic core (seam-injected like the puller);
server.ts only constructs + wires. The guard's detector is a pure function
per the integration-review finding (loadRegistry stays a hot dependency-free
read). The onAccepted hook lands in the existing createDeliverMessageHandler
seam — the exact place the spec's round-1 integration review corrected the
design to (ownAction/confirmClaim run on the ROUTER, the wrong machine).

## 4. Blast radius

Dark everywhere except explicitly-replication-enabled pairs (today: the
echo Laptop+Mini). The onAccepted hook is one optional-chained call on a
coordinator that is undefined when dark. The reflex route 503s when dark.
The guard runs only inside the same gated block. Template/migration text
is awareness-only (the endpoint answers 503 until the layer is live).

## Evidence

- `tests/unit/WorkingSetPullCoordinator.test.ts` — 12 passing: ownership
  gating, DURABLE op-key dedupe across a coordinator restart,
  pressure-defer-leaves-opkey-unburned, prevOwner-self skip, plural
  nomination (newest-first, cap, cappedNominees, self excluded), genuine
  vs busy attempt accounting, live-source clear-on-success, staggered
  drain (sequential, stale-owner clear, drain gate), reflex rate-limit +
  coalescing.
- `tests/unit/PeerVisibilityGuard.test.ts` — 5 passing: pure detector
  matrix, cross-boot dedupe (crash-loop cannot re-spam), disappearance
  episode lifecycle with stranded topics named + silent re-peer clear,
  flap collapse to ONE notice.
- `tests/integration/working-set-reflex-route.test.ts` — 2 passing: 503
  dark / 400 / 200-through-a-real-coordinator / 429.
- `tests/e2e/working-set-handoff-lifecycle.test.ts` — 2 passing,
  production-shaped (REAL createDeliverMessageHandler + REAL signed
  dispatcher/client + REAL journal streams): (1) a topic move lands the
  file on the receiver, verified against the source's on-disk original +
  re-delivery/op-key dedupe leaves it untouched; (2) THE EXO CASE —
  producer offline at move, pending-pull survives a restart, re-fires on
  the peer's return, file lands, record cleared.
- Full P2 sweep: 95 tests across 11 suites green; typecheck + lint chain
  (69 registry categories) + docs-coverage clean.
