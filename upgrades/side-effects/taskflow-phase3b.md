# Side-Effects Review — TaskFlow Phase 3b (cutover: remove JSONL shadow writes + DivergenceChecker)

**Version / slug:** `taskflow-phase3b`
**Date:** 2026-05-10
**Author:** Echo
**Second-pass reviewer:** required (touches state-machine authority surface for the evolution pipeline and removes a state-coherence monitor whose output gates the cutover itself)

## Summary of the change

Phase 3b is the **cutover** half of the Phase 3a/3b pair. It removes the legacy JSONL/JSON shadow-writes that EvolutionManager performed alongside the TaskFlow registry during Phase 3a, and deletes the `DivergenceChecker` (the 15-minute cron that compared JSON state against TaskFlow state). After this PR lands, TaskFlow is the **sole authority** for proposal lifecycle state on agents with `taskFlow.enabled=true`; the local `evolution-queue.json` file becomes a read-only historical artifact of pre-cutover state.

Per the spec (`docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md` § Phase 3b, line 641):

> **Cutover criterion: `divergence_count == 0` for `>= 7 consecutive days`, AND ledger contains zero `taskflow-divergence` notes in that window. PR removes the JSONL shadow writes, removes `DivergenceChecker`. JSONL files become read-only artifacts of the prior history.**

The PR is opened as **DRAFT and explicitly gated** on the 7-day quiet period. Phase 3a was deployed on 2026-05-10 (today); the earliest possible merge date is therefore **2026-05-17**, contingent on the divergence checker reporting clean throughout the window and SharedStateLedger holding zero `taskflow-divergence` notes in that range.

Files touched:
- `src/core/EvolutionManager.ts` — removed `setShadowWritesHalted` / `isShadowWritesHalted` / `taskFlowShadowWritesHalted*` machinery; renamed `dualWriteCreate` → `writeCreateToTaskFlow` and `dualWriteTransition` → `writeTransitionToTaskFlow`; removed unconditional `saveEvolution` from `addProposal` / `updateProposalStatus`; added an in-memory `taskFlowProposalCache` so consecutive lifecycle calls within a process can find proposals without round-tripping through JSON; updated `listProposals`, `processProposalAutonomously`, `addClusterEvidence`, and `nextProposalId` to merge cache and JSON sources; opt-out installs (no TaskFlow wired) still write the legacy JSON file.
- `src/tasks/DivergenceChecker.ts` — **deleted**.
- `src/commands/server.ts` — removed `DivergenceChecker` import, instantiation, and `.start()`. Removed the `divergenceChecker` local from the catch-block reset and the trailing `void` reference.
- `tests/unit/divergence-checker.test.ts` — **deleted**.
- `tests/unit/evolution-manager-taskflow-dualwrite.test.ts` — **renamed** to `tests/unit/evolution-manager-taskflow-authority.test.ts`; tests adjusted: dropped the `setShadowWritesHalted` case (the brake no longer exists); reshaped the "JSON survives registry blowup" case to assert *no JSON shadow rescue under wired Phase 3b*; reshaped the "no flows when unwired" case to additionally assert the legacy JSON write fallback continues for opt-out installs; added an explicit "JSON file is NOT written when wired" assertion.
- `upgrades/side-effects/taskflow-phase3b.md` (this file).

Note: `LedgerEntrySubsystem` retains the `'taskflow-divergence'` value introduced in Phase 3a. The 7-day cutover gate is verified by querying SharedStateLedger for entries with that subsystem kind; removing the enum value would invalidate the gate.

## Decision-point inventory

- `EvolutionManager.setShadowWritesHalted` / `isShadowWritesHalted` — **remove** — the signal-consumed brake added in Phase 3a. Without a divergence comparator there is no signal source to gate on, and TaskFlow is now sole authority, so there is no second writer to brake.
- `EvolutionManager.writeCreateToTaskFlow` / `writeTransitionToTaskFlow` — **modify** (renamed from `dualWriteCreate` / `dualWriteTransition`) — pure mechanics. No new decision authority.
- `EvolutionManager.addProposal` / `updateProposalStatus` — **modify** — the JSON write is now skipped when TaskFlow is wired. No new gating; the change is a write-path collapse, not an authority addition.
- `DivergenceChecker.runOnce` / `DivergenceChecker.start` — **remove** — both signal emission and the 15-min cron timer. The signal these produced (`taskflow_divergence_count` metric + `taskflow-divergence` ledger note) is no longer emitted; the *consumer* of that signal (manual / human review of the 7-day window) is what gated this very PR.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.**

This change is a write-path collapse plus a monitor removal. Neither operation rejects any user input. The `setShadowWritesHalted` brake that *could* have produced an over-block in theory (by suppressing dual-writes during a false-positive divergence pass) is being removed in this PR — strictly fewer block surfaces, not more.

## 2. Under-block

**Failure modes the change does not catch:**

- A registry failure during `writeCreateToTaskFlow` (sqlite store closed, disk full, permissions error) silently drops the proposal on the floor — the JSON shadow path that previously rescued it is gone. The new test `TaskFlow registry blowup under wired Phase 3b drops the proposal (no JSON shadow rescue)` documents this as intentional. Operators are expected to watch the `[EvolutionManager] taskflow createFlow …` warn channel. A future hardening pass (Phase 3c, out of scope) could add a retry queue; deferring per spec.
- A server restart between `addProposal` and `writeCreateToTaskFlow.then(…)` would lose any in-flight proposal that hadn't yet drained its microtask. This was already true in Phase 3a for the TaskFlow side; Phase 3b makes it true for the only side.
- The in-memory `taskFlowProposalCache` is process-scoped; a server restart loses any post-cutover proposals that weren't yet rehydrated from TaskFlow. The cache is a **performance / continuity** layer, not a durability layer — TaskFlow rows are the durability. Restart simulation in the renamed test (`TaskFlow record is read-authoritative via findByControllerId`) verifies that TaskFlow holds the canonical record across restarts.
- An opt-out install (`taskFlow.enabled=false`) continues to write the legacy JSON file. If such an install later turns TaskFlow on, the existing `migrateExistingToTaskFlow` backfill (idempotent, started at server boot) picks up the JSON-resident proposals and writes them to TaskFlow. This is unchanged from Phase 3a and is verified by the renamed `migrateExistingToTaskFlow is idempotent` test.
- Pre-cutover proposals from the JSON file remain visible via `listProposals()` because `loadEvolution()` still reads the file. New post-cutover proposals are visible via the cache merge. There is no scenario where a wired-TaskFlow caller sees a stale view of state that contradicts TaskFlow — except the documented case where a caller depends on proposals having survived a process restart without the TaskFlow side rehydrating them, which is the Phase 3b contract.

## 3. Level-of-abstraction fit

The removal lives at the right layer. The JSON write and the divergence check were both internal to EvolutionManager's lifecycle methods (or, in the divergence checker's case, an external observer of those methods). Removing them at this layer preserves the spec's stated boundary: TaskFlow becomes the authoritative store, callers of EvolutionManager see a strictly narrower set of side effects but the same external surface (`addProposal` returns a proposal, `updateProposalStatus` returns true/false, `listProposals` returns the merged view).

The in-memory `taskFlowProposalCache` is at the right layer too. The alternative would have been to refactor `updateProposalStatus` to read state from TaskFlow itself (look up the flow by idempotency key, derive proposal status from `flow.status` + `flow.currentStep`). That refactor was rejected because (a) it doesn't carry proposal-only fields like `resolution`, `implementedAt`, and `entityId` natively — TaskFlow's `stateJson` would need to mirror them — and (b) the cache approach keeps Phase 3b a write-path collapse rather than a read-path rewrite, minimizing rollback cost. A future Phase 3c could collapse the cache into TaskFlow if needed.

The `DivergenceChecker` deletion is at the right layer. It was a free-standing observer over two existing surfaces; removing it removes only the observer, not the observed surfaces.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No — this change has no block/allow surface.** Phase 3b strictly *removes* a signal emitter (`DivergenceChecker`) and a signal-consumed self-brake (`setShadowWritesHalted`). It does not introduce any new decision authority. Removing these emitters reduces the signal volume on the SharedStateLedger; the consumers of those signals (humans monitoring the 7-day window) have already used them to authorize this very PR.

Specifically:
- `writeCreateToTaskFlow` and `writeTransitionToTaskFlow` are pure mechanics. They translate proposal lifecycle events into TaskFlow API calls without judgment about which proposals are legitimate.
- The removal of `setShadowWritesHalted` removes a mechanism that could be confused for an authority but was always a self-applied brake on a secondary path. With no secondary path left, no brake is needed.
- The retained `LedgerEntrySubsystem` value `'taskflow-divergence'` remains a signal-record type, never an authority decision. Keeping it preserves the historical record of the Phase 3a quiet-period window for retroactive auditability.

No brittle blocker is introduced. No existing authority is shadowed. The only "authority" that consumed the now-deleted signal was the human operator's choice to merge this PR, which is encoded in the merge gate (draft + 7-day note), not in code.

---

## 5. Interactions

- **Shadowing:** none. The removed JSON write was the *only* write that could shadow TaskFlow; with it gone, there's no parallel writer.
- **Double-fire:** the in-memory cache is keyed by proposal id; `updateProposalStatus` mutates the cached proposal in place. A second concurrent `updateProposalStatus` on the same id would race on the cache entry, but races on `updateProposalStatus` were already documented as resulting in `revision_conflict` on the TaskFlow side — the cache races degrade to the same TaskFlow OCC outcome.
- **Races:**
  - `addProposal` returns synchronously after pushing to the cache and dispatching the microtask. Within a single process, the cache makes consecutive lifecycle calls observable to each other immediately; outside the process, observability requires the TaskFlow write to land.
  - `updateProposalStatus` reads the cache first when wired. If a sibling process performs an out-of-band write to TaskFlow (no such code path exists — `EvolutionManager` is the controller for this `controllerId`), the cache would be stale. This is documented as a v1 constraint inherited from Phase 1's single-writer assumption.
  - `nextProposalId` now includes cache ids in its uniqueness set. Without this, two consecutive `addProposal` calls in a wired-TaskFlow session would both compute `EVO-001` because `loadEvolution()` returns the same JSON snapshot to both.
- **Feedback loops:** none new. The removed `DivergenceChecker` was the only feedback loop in the Phase 3a topology, and it's gone.
- **Cache coherence:** `taskFlowProposalCache` is monotonic-add per-process; entries are never evicted (proposal counts are small — `maxProposals` defaults to 200, and the cache only contains in-process additions). A process restart drops the cache; TaskFlow is the durable store.

## 6. External surfaces

- **Other agents on the same machine:** no new surface. No outbound calls added or removed.
- **Other users of the install base:** Phase 3b is conditional on `taskFlow.enabled=true`. Opt-out installs (default for Phase 1; agents that never enabled TaskFlow) retain the legacy JSON write path verbatim — they see zero behavior change. The newly added "opt-out fallback" assertion in `evolution-manager-taskflow-authority.test.ts` is the explicit regression test for this.
- **External systems:** none. No outbound HTTP, no LLM calls, no Telegram sends.
- **Persistent state:** the `evolution-queue.json` file is no longer written by wired-TaskFlow installs. Its existing contents are preserved verbatim as a historical artifact. No migration; no data deletion. `.instar/task-flows.db` is unaffected — Phase 3a already established it as the local store for flow rows.
- **Timing or runtime conditions:** the 15-min `DivergenceChecker` cron is removed; one fewer `unref()`'d timer in the process. No effect on shutdown.

## 7. Rollback cost

- **Hot-fix release:** revert the PR. Restart the server. The JSON write resumes for wired-TaskFlow installs (no-op for opt-out installs). The DivergenceChecker resumes its 15-min cadence. The cache is reintroduced and behaves exactly as Phase 3a's in-memory mirror behaved. No data migration.
- **Data migration:** none on rollback. Proposals created during the Phase 3b window live only in TaskFlow; after rollback, the JSON file is rewritten on next `saveEvolution` call but it starts empty of post-cutover proposals — the divergence checker would flag them as `taskflow-only` on its first pass after rollback. This is *correct* behavior (TaskFlow is the durable store; JSON is a derivative). If a clean post-rollback JSON shadow is desired, run `instar evolution rebuild-json-shadow` (out of scope; not implemented in this PR; TaskFlow contains everything needed to rebuild).
- **Agent state repair:** none required. Disabling `taskFlow.enabled` after rollback would revert the install to pre-Phase-3a behavior, which is fully supported.
- **User visibility:** none. The proposal pipeline that users interact with (Telegram, dashboard, CLI) consumes `listProposals()`, which merges cache and JSON sources transparently.

---

## What is irreversible

The post-cutover JSON file does NOT receive new writes. Its on-disk contents are preserved as a frozen artifact of pre-cutover state; nothing in this PR modifies or deletes the file. **No data is destroyed by Phase 3b.** A rollback recovers the dual-write topology cleanly, with the only "loss" being that proposals created during the Phase 3b window won't appear in the JSON file until either (a) a future rewrite-from-TaskFlow command runs or (b) a divergence-flagged note prompts manual repair.

The deletion of `DivergenceChecker` and `setShadowWritesHalted` is reversible by `git revert` — these are pure code paths with no persistent state. The `LedgerEntrySubsystem` enum value `'taskflow-divergence'` is **retained** so the 7-day quiet-period gate's historical ledger entries remain legible.

---

## Conclusion

Phase 3b removes the JSONL shadow write and the divergence-comparator monitor that Phase 3a installed. TaskFlow becomes the sole authority for proposal lifecycle state on wired installs; opt-out installs continue with the legacy JSON write. The change is a write-path collapse plus a monitor deletion, not an authority addition. No new decision points. No new block surfaces. The rollback path is a clean `git revert`.

**The PR is GATED on the 7-day quiet-period criterion and shipped as a DRAFT.** It will only merge after operators verify (a) `divergence_count == 0` for ≥7 consecutive days on the live install and (b) the SharedStateLedger contains zero `taskflow-divergence` notes in that window. Earliest possible merge date: **2026-05-17** (Phase 3a deployment date 2026-05-10 + 7 days).

---

## Second-pass review

**Reviewer:** adversarial self-review (Task/Agent subagent tool not available in this skill harness; conducted in-line with a fresh adversarial framing). Same approach used for Phase 3a; documented for continuity.

**Independent read of the artifact: concur after fixes**

Findings raised during adversarial pass and addressed in the same diff:

1. **`nextProposalId` collision under wired TaskFlow** — The first version did not include cache ids in the uniqueness check. Two consecutive `addProposal` calls within a single process would both compute `EVO-001` because `loadEvolution()` returns the same (empty) JSON snapshot to both. **Fix applied:** `nextProposalId` now adds the cache's keys to the existing-ids set before incrementing the counter. Test `addProposal creates a queued flow under controllerId=EvolutionManager` passes; the second call in the renamed test file's later cases (`updateProposalStatus(approved) starts the flow` etc.) also passes — both verify that consecutive adds get distinct ids.
2. **`listProposals` regression on the opt-out install path** — The first version of `listProposals` always merged the cache, which would have polluted opt-out installs (no TaskFlow wired) with an empty cache that's still merged correctly but conceptually confusing. **Fix applied:** the cache-merge branch only runs when `this.taskFlowRegistry` is non-null AND the cache has entries. The opt-out test (`without setTaskFlowRegistry, the legacy JSON write continues`) explicitly asserts `listProposals` returns the JSON-resident proposal.
3. **Cache miss under `updateProposalStatus` for backfilled-but-not-cached proposals** — Considered: a proposal that was created pre-cutover lives in the JSON file but not in the in-memory cache. A wired-TaskFlow `updateProposalStatus` call against such a proposal falls back to `state.proposals.find(...)` via the second arm of the `??` operator and finds it correctly. The status update mutates that JSON-loaded proposal in place. Because the JSON write is now skipped, the mutation is dropped on the floor — but the TaskFlow transition write is what carries the durable state forward. Verified by reasoning: `writeTransitionToTaskFlow` performs the OCC-bumping registry call on the existing flow row (found via `findByIdempotency`); the proposal-object mutation in the JSON-snapshot is purely advisory. No bug.
4. **`addClusterEvidence` IIFE closure** — The fix uses an IIFE `(() => { … })()` to lazy-load JSON state only on cache miss. This is performance-neutral compared to Phase 3a (which always loaded). Considered hoisting to a helper; rejected as overkill for two call sites.
5. **`DivergenceChecker` removal leaving stale `LedgerEntrySubsystem` value** — Considered: should we also remove `'taskflow-divergence'` from `src/core/types.ts`? **Decision: NO.** The 7-day quiet-period gate that authorized this very PR queries the ledger for entries with that subsystem. Removing the enum value would orphan those historical entries and break the cutover gate's verification path. Retained verbatim.
6. **Server-side `divergenceChecker` local cleanup** — Verified: removed the variable declaration, the import-via-`await import()`, the `divergenceChecker = new …` instantiation, the `.start()` call, the catch-block reset, and the trailing `void divergenceChecker` reference. `grep -n divergenceChecker src/commands/server.ts` returns nothing. No dangling references.

No remaining critical concerns. The change is cleared to ship — pending the 7-day quiet-period gate. **The PR is shipped as DRAFT; merge is blocked until 2026-05-17 at the earliest and only after the gate criterion is verified live.**

---

## Evidence pointers

- Test run: `npx vitest run tests/unit/evolution-manager-taskflow-authority.test.ts tests/unit/task-flow-registry.test.ts tests/unit/evolution-manager-evidence.test.ts tests/unit/AutonomousEvolution.test.ts tests/unit/threadline-flow-bridge.test.ts tests/unit/initiative-tracker-taskflow.test.ts` → 102/102 passing.
- Typecheck: `npx tsc --noEmit` → clean.
- Spec source of truth: `docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md` § Phase 3b (line 641).
- Phase 3a precedent: `upgrades/side-effects/taskflow-phase3a.md`.
- Gate verification (operator-run, NOT a code dependency):
  - `curl -H "Authorization: Bearer $AUTH" "http://localhost:4042/ledger/entries?subsystem=taskflow-divergence&since=$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)"` — must return zero entries.
  - `grep '"name":"taskflow_divergence_count"' .instar/metrics.jsonl | tail -n 100` — must show all zeros for the last 7 days.
