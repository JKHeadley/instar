# Side-Effects Review — The context budget sentinel reads pool-live ownership (Phase 1 health on pool-live agents)

**Version / slug:** `cb-sentinel-pool-owner`
**Date:** `2026-11-20`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** independent subagent (see the end of this file)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §9.3 (owner with placement live), §7.8 (the sentinel acts as owner only), §17 (stale layers: rebuild requests)
**Stacked on:** #3568 (and through it #3566, which introduced the pool-live owner rule for the coordinator)

## Summary of the change

Found while checking Phase 1's clean week on Echo. `GET /context-budget/sentinel` showed `layerFreshness.counts.observedOnly: 14` of 14 topics. The sentinel's `ownsTopic` and `ownsFold` returned `unknown` whenever the session pool's placement is live, and Echo is (`live-transfer`). So on a pool-live agent the sentinel can never request a stale-layer rebuild, clear an orphan hold, or reconcile a fold. It only observes. That undermines the clean week it exists to measure.

- **`foldCoordinatorBoot.poolLiveOwner(record, self)`:** one shared §9.3 rule. A topic is owned when its ACTIVE ownership record names this machine. A missing record or identity is `unknown`; placing, transferring or released is not owned. The coordinator's `isOwner` and `isSweepOwner` (from #3566) now call it.
- **`server.ts`:** the ownership closures (`foldOwnershipRecord`, `foldSelfMachineId`, with boot-order TDZ read as unknown) are hoisted to a shared const used by both the coordinator and the sentinel.
  - `ownsTopic(topicKey)`: placement live means `poolLiveOwner`; otherwise `true`, as before.
  - `ownsFold(rec)`: placement live means owned AND (the host OR this machine's own record); otherwise unchanged.

**Files.** Modified: `foldCoordinatorBoot.ts`, `server.ts`; tests `fold-pool-ownership.test.ts` (+1) and the e2e wiring check. About 40 LOC.

## Decision-point inventory

The sentinel's owner check (modify): from "never on a pool-live agent" to the §9.3 rule. What it may do as owner is unchanged (rebuild request, orphan-hold clear, quarantine reconciliation), with its own brakes and the self-action governor's handles.

## 1. Over-block
None. It only widens the sentinel's ability to act from never to where it truly owns.

## 2. Under-block
At boot, before the registry exists, ownership reads `unknown`, so the first ticks observe only. Once the registry is built, the next tick acts.

## 3. Level-of-abstraction fit
One rule in the coordinator boot module, used by both consumers, so they cannot disagree on who owns a topic.

## 4. Signal vs authority compliance
The sentinel's actions are its existing, reviewed ones, under the self-action governor (admit and token). This changes only where it is allowed to run them, matching the spec's owner-only rule.

## 5. Interactions
- **Stale-layer rebuilds:** the sentinel may now request re-projection for topics Echo owns. That is deterministic, with no model call (`reproject`), and braked per topic.
- **Orphan holds:** may now be cleared on owned topics, through the governor admission.
- **Topics owned by another machine** in the pool stay observe-only here, which is correct.

## 6. External surfaces
The sentinel may now raise its stale-layer notice on owned topics (one per episode, braked). That is its designed behaviour, which pool-live agents were missing.

## 7. Multi-machine posture
This is the multi-machine fix itself: ownership comes from the replicated ownership registry, so exactly one machine (the active owner) acts.

## 8. Rollback cost
A revert. Behaviour returns to observe-only on pool-live agents.

---

## Second-pass review

(appended below by the reviewer)

Concur with the review.
- Rule checked per status: active+self ⇒ owned; active+other, placing, transferring, released ⇒ not owned; no record or no mesh id ⇒ unknown. Only the single active owner can act, so no cross-machine double action and no action on a topic another machine owns.
- Boot order holds at runtime: `foldOwnershipRecord` / `foldSelfMachineId` sit in the same `try` block that later builds the sentinel (the sentinel uses `built` from that block). `sessionOwnershipRegistry` is a `let` declared later in the same function scope, so an early call throws a TDZ ReferenceError, which is caught and read as unknown. `_meshSelfId` is module-level.
- `ownsFold` with placement live: an active record naming this machine plus `rec.machineId === built.holderId` still lets this machine reconcile its own quarantined fold after its session died. If the record was released, nothing acts (it stays observe-only), which matches §9.3.
- Nit: the old comment above `ownsFold` ("pool placement live ⇒ unknown") was left in place and now contradicts the new comment under it; delete it. The sentinel closures are covered only by the source-string e2e check, not by a behavioural test. Tests: 73/73 unit and 4/4 e2e pass.
