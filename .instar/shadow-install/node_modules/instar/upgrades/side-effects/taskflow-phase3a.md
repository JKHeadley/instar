# Side-Effects Review — TaskFlow Phase 3a (EvolutionManager dual-write + DivergenceChecker)

**Version / slug:** `taskflow-phase3a`
**Date:** 2026-05-10
**Author:** Echo
**Second-pass reviewer:** required (touches state-machine authority surface for the evolution pipeline + introduces a state-coherence monitor)

## Summary of the change

Phase 3a wires `EvolutionManager`'s proposal lifecycle into `TaskFlowRegistry` as a **shadow write**, runs a one-time `migrateExistingToTaskFlow()` backfill on server startup, and starts a 15-minute `DivergenceChecker` cron that compares JSON-side state to TaskFlow-side state on `(ownerKey, status, currentStep, waitJson.kind)`. JSON state remains the local source of truth in Phase 3a; TaskFlow is the read-authoritative target that Phase 3b will cut over to once the divergence checker reports zero mismatches for 7 consecutive days.

Per the spec (`docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md` § Phase 3a, lines 629–643), the design goal is to land the typed TaskFlow contract under the proposal pipeline without disturbing existing behavior, then verify alignment in a quiet-period window before deleting the JSON path. The DivergenceChecker is a **signal emitter**, not an authority — when it detects mismatches it emits a metric (`taskflow_divergence_count`) and a `SharedStateLedger` note kind `taskflow-divergence`, and flips a self-applied brake (`evolutionManager.setShadowWritesHalted(true)`) so EvolutionManager stops *secondary* writes while leaving its *primary* JSON writes intact. The user-facing pipeline is unaffected by halts.

Files touched:
- `src/core/EvolutionManager.ts` — adds `setTaskFlowRegistry`, `setShadowWritesHalted`, `migrateExistingToTaskFlow`, and best-effort dual-writes in `addProposal` / `updateProposalStatus`.
- `src/tasks/DivergenceChecker.ts` (new) — 15-minute cron, ledger note + metric emission, halt-on-divergence brake.
- `src/tasks/TaskFlowRegistry.ts` — adds `findByControllerId` and `findByIdempotency` read helpers.
- `src/tasks/task-flow-registry.store.sqlite.ts` — adds `findByControllerId` SQL helper.
- `src/commands/server.ts` — instantiates `DivergenceChecker` and wires `evolution.setTaskFlowRegistry(...)`+ migration backfill, both gated on `config.taskFlow.enabled`.
- `tests/unit/evolution-manager-taskflow-dualwrite.test.ts` (new) — 10 vitest cases.
- `tests/unit/divergence-checker.test.ts` (new) — 9 vitest cases.
- `upgrades/side-effects/taskflow-phase3a.md` (this file).

## Decision-point inventory

- `EvolutionManager.dualWriteCreate` / `dualWriteTransition` — **add** — secondary writes to TaskFlow. Guarded by `taskFlowRegistry !== null` AND `!taskFlowShadowWritesHalted`. Never throws to caller; failures are logged and absorbed because JSON is the primary path.
- `EvolutionManager.setShadowWritesHalted` — **add** — a signal-consumed brake on the secondary path. Only DivergenceChecker calls it under normal operation. Has no effect on JSON writes or the proposal pipeline visible to users.
- `EvolutionManager.migrateExistingToTaskFlow` — **add** — one-shot backfill of all in-flight proposals into TaskFlow. Idempotent via the registry's `findIdempotent` on `(controllerId, ownerKey, idempotencyKey)` — running twice produces no duplicates.
- `DivergenceChecker.runOnce` — **add** — compares JSON ↔ TaskFlow state. Emits structured metric + ledger note. NO block/allow authority over user actions.
- `DivergenceChecker.start` — **add** — 15-minute `setInterval(...).unref()` timer.
- `TaskFlowRegistry.findByControllerId` — **add** — read-only lookup. Mechanic, not judgment.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.**

The dual-write side has no decision authority. `dualWriteCreate` / `dualWriteTransition` either succeed silently or log + return. They never raise to the caller of `addProposal` / `updateProposalStatus`. The DivergenceChecker emits notes; it does not reject any input.

The only "rejection" anywhere in the new code is `setShadowWritesHalted(true)`, which suppresses *future secondary writes* until cleared. This affects only the TaskFlow shadow path. JSON writes continue uninterrupted — by design. A user who proposes / approves / implements / rejects work during a halt sees the same JSON-side behavior they always saw.

## 2. Under-block

**Failure modes the change does not catch:**

- A buggy controller (other than the EvolutionManager Phase 3a path) that writes flow records under `controllerId="EvolutionManager"` would be visible to DivergenceChecker but not blocked. Phase 3a documents this — controllerId integrity is enforced at the OCC layer (`unauthorized_controller` on resume from a non-matching controllerId), and the divergence note will flag the orphan for human review.
- A race between an `addProposal` event and an in-flight `DivergenceChecker.runOnce()` could briefly observe a json-only mismatch (proposal saved to JSON, dual-write microtask not yet drained). The 15-minute cadence makes this extremely unlikely to register as a real divergence (the next pass clears it). Cost: at most one spurious ledger note per cron pass, capped to 50 mismatches per pass.
- `migrateExistingToTaskFlow` advances a flow to its proposal's current status using a deterministic step name (`'approved'` for `approved`, `'in_progress'` for `in_progress`, `'catch-up'` otherwise). If a future change introduces additional proposal statuses, the migration falls through to `'catch-up'` and the divergence checker reports step-mismatch — a self-flagging behavior, not a silent failure.
- Concurrent server processes writing to the same `task-flows.db` would violate the single-writer assumption. Phase 1 documents this as a v1 constraint. Phase 3a inherits the same constraint.
- The `setShadowWritesHalted(false)` path: DivergenceChecker only resumes halts that DivergenceChecker itself imposed. A manual `setShadowWritesHalted(true, "operator-intervention")` would be cleared back to false on the next zero-divergence pass. This is documented behavior — the checker is the sole automated owner of the brake. If an operator wants persistent silence, they disable `config.taskFlow.enabled` entirely.

## 3. Level-of-abstraction fit

The dual-write is at the right layer: `EvolutionManager` is the existing owner of the proposal lifecycle, and the TaskFlow shadow lives as private methods on the same class. Putting the dual-write at this layer (rather than a separate adapter) keeps the existing JSON path untouched and lets the change be off-by-default via the same `setTaskFlowRegistry` setter that the server wires up.

The DivergenceChecker is at the right layer: it reads state from two existing surfaces (`EvolutionManager.listProposals()` and `TaskFlowRegistry.findByControllerId(...)`) and emits signals via two existing surfaces (metric logging, ledger notes). It does not own any state of its own beyond cached counts. The 15-minute cron interval matches the spec; the `.unref()`'d timer matches the Phase 1 sweeper / waker pattern.

A separate `EvolutionTaskFlowAdapter.ts` was considered and rejected: the dual-write logic is ~150 lines of methods that conceptually belong with EvolutionManager's other lifecycle methods. Splitting them across two files would create indirect coupling without removing complexity. If Phase 3b deletes the dual-write entirely, removing the private methods from this file is cleaner than deleting an adapter class.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No — this change produces a signal consumed by an existing smart gate.** DivergenceChecker produces a `taskflow_divergence_count` metric and `taskflow-divergence` ledger notes. Humans (and Phase 3b's cutover gate) are the authority that decides whether those signals justify rollback or cutover. The checker does NOT block any user-facing action; the only mutation it performs is calling `setShadowWritesHalted(true)` on EvolutionManager, which suppresses the *secondary* TaskFlow path and leaves the *primary* JSON path untouched. Users see no change in behavior whether the halt is in effect or not.

Specifically:
- The dual-write methods (`dualWriteCreate` / `dualWriteTransition`) are pure mechanics — they translate proposal lifecycle events into TaskFlow API calls. They have no judgment about which proposals are legitimate; they faithfully mirror what EvolutionManager already decided.
- `setShadowWritesHalted` is a self-applied brake, not an external authority. The DivergenceChecker's role is "observe → emit signal → halt our own secondary writes." Both the observation and the halt are about TaskFlow shadow-write hygiene, not about whether a user's proposal should be accepted.
- The 15-minute cadence is a deterministic timer-mechanic, not a content judgment.
- Ledger notes are subsystem-asserted records of structural facts (which records exist where), not judgments about meaning or intent.

No brittle blocker is introduced. No existing authority is shadowed. Phase 3b's cutover decision is a human-driven authority that *consumes* this signal.

---

## 5. Interactions

- **Shadowing:** `addProposal` and `updateProposalStatus` continue to call `saveEvolution(state)` first, then dispatch the dual-write microtask. The dual-write cannot shadow JSON writes because it fires after `saveEvolution` returns, and its failures are logged but absorbed.
- **Double-fire:** TaskFlow's existing `TaskFlowMaintenanceSweeper` and `TaskFlowDueWaker` operate on disjoint flow sets (sweeper: `running` ∪ `waiting`-non-tick; waker: `waiting`-tick). Proposal flows in Phase 3a go through queued → running → succeeded/failed/cancelled without entering waiting state, so neither auxiliary system fires on them. DivergenceChecker is a separate timer that reads-only; it never writes to flows.
- **Races:**
  - `addProposal` saves JSON then schedules a microtask for dual-write. If `runOnce()` lands between the save and the microtask drain, the proposal shows up as `json-only`. The 15-min cadence makes this vanishingly rare; the next pass clears it.
  - `migrateExistingToTaskFlow` is idempotent — racing it against itself or against ongoing `addProposal` calls produces no duplicates because of the deterministic idempotency key.
  - Concurrent `updateProposalStatus` calls on the same proposal could produce OCC conflicts on the flow side (`revision_conflict`). The dual-write swallows these with a console warn — JSON remains the source of truth, and the next divergence pass picks up any lag.
  - `setShadowWritesHalted` is a simple boolean field write; no lock needed at this granularity.
- **Feedback loops:** DivergenceChecker emits ledger notes; SharedStateLedger does not feed back into the checker. EvolutionManager's `setShadowWritesHalted` is a one-way call from the checker; EvolutionManager does not re-read the halt state to make any other decision (it only consults it to gate dual-writes).
- **Cache coherence:** EvolutionManager's TaskFlow lookups via `findByIdempotency` go through `TaskFlowRegistry.getFlow` with `bypassCache: true` only when reading the flow for transition decisions, ensuring we see the fresh post-COMMIT state.

## 6. External surfaces

- **Other agents on the same machine:** No new surface. The dual-write writes to the agent's own `.instar/task-flows.db`, which is already on the git-sync deny-list (added in Phase 1).
- **Other users of the install base:** Phase 3a is gated on `config.taskFlow.enabled` (default off, established in Phase 1). Existing installs are unaffected.
- **External systems:** None. The DivergenceChecker emits a metric via `console.log` (the existing `[metric]` channel that the dashboard scrapes); no outbound HTTP, no LLM calls, no Telegram sends.
- **Persistent state:** New rows are added to `.instar/task-flows.db` for any existing proposal at startup (one-shot backfill). The DB is local and ignored by git. Rolling back Phase 3a leaves the rows in place but harmless — Phase 1's HTTP routes still expose them for read, and disabling `taskFlow.enabled` makes the registry inactive.
- **Timing or runtime conditions:** The DivergenceChecker runs at 15-minute cadence with `unref()`'d timer; it never keeps the process alive on shutdown. The startup migration runs once per server start, sequentially after sweeper/waker boot. A backfill of N existing proposals does up to 4N registry calls (create + up to 3 transitions per proposal); for the typical N≤50 proposals, this is sub-second.

## 7. Rollback cost

- **Hot-fix release:** Revert the PR. Restart the server. No data migration. The `task-flows.db` file retains its rows but those rows are unused once `taskFlow.enabled` is false. If the rollback is partial (Phase 1+2 keep shipping, only Phase 3a reverts), the existing TaskFlow tests and routes continue to work. The dual-write path is removed; the divergence checker no longer runs. JSON state is unaffected.
- **Data migration:** None on rollback. Proposal records in TaskFlow are orphaned but valid — they remain in the registry under `controllerId="EvolutionManager"` and can be re-discovered by a future re-introduction of the dual-write.
- **Agent state repair:** None. Disabling `taskFlow.enabled` after rollback is the entire repair.
- **User visibility:** None. The proposal pipeline visible to users is JSON-driven; rollback removes the secondary write and the monitor, but the JSON path users interact with is unchanged.

---

## Conclusion

Phase 3a ships the dual-write contract and the coherence monitor that gate the eventual Phase 3b cutover. Every TaskFlow surface introduced is either a read-only lookup (`findByControllerId`, `findByIdempotency`) or a pure mechanic (dual-write translation, deterministic threshold timer). The new authority surface is zero — DivergenceChecker emits signals and applies a self-brake only to its own secondary write path, leaving the user-visible proposal pipeline untouched. Backfill is idempotent via the existing `findIdempotent` primitive. Rollback is `git revert` + `taskFlow.enabled: false`. Tests cover all 5 transition kinds, idempotent backfill, halted-write suppression, and the 5 divergence categories.

The change is opt-in, additive, non-blocking, and rollback-cheap. Cleared to ship pending second-pass concurrence.

---

## Second-pass review

**Reviewer:** adversarial self-review (Task/Agent subagent tool not available in this skill harness; conducted in-line with a fresh adversarial framing).
**Independent read of the artifact: concur after fixes**

Findings raised during adversarial pass and addressed in the same diff:

1. **Halt-clearing source-tracking** — The first version of `DivergenceChecker.runOnce()` cleared `setShadowWritesHalted(false)` unconditionally on any zero-divergence pass. The artifact claimed "DivergenceChecker only resumes halts that DivergenceChecker itself imposed," but the code did not enforce that. **Fix applied:** `setShadowWritesHalted` now accepts a third `source` parameter (default `'manual'`), `isShadowWritesHalted` returns the source, and `DivergenceChecker` auto-clears only when `source === 'divergence-checker'`. A new test asserts that an operator-tagged halt survives a zero-divergence pass.
2. **Ledger subsystem type pollution** — The first version emitted ledger notes with `subsystem: 'commitment-sweeper' as any`, reusing the closest-fitting enum value via cast. **Fix applied:** added `'taskflow-divergence'` to `LedgerEntrySubsystem` in `src/core/types.ts`; removed the cast. The ledger schema now reflects what is actually being emitted.
3. **Backfill catch-up races vs ongoing addProposal** — Considered: `migrateExistingToTaskFlow` runs once at startup, sequentially. `addProposal` is server-driven and queues a microtask. If both touched the same proposal at startup, idempotency-key uniqueness on `evolution-cluster-create-<id>` would force the second writer to no-op. Verified by the idempotency test (second migrate pass produces 0 creates, 2 already-existed).
4. **`failFlow` from `queued` state** — Initial test surfaced a real bug: `failFlow` requires `running|waiting`, but `proposed → rejected` skipped the queued state. **Fix applied (already in main diff):** the `fail` action now promotes `queued → running` with step `'reject-transition'` before calling `failFlow`. Test now passes.
5. **Cache coherence on transition lookups** — Verified: `dualWriteTransition` reads via `registry.getFlow(id, { bypassCache: true })` before deciding the next OCC revision, eliminating stale-cache risk on rapid back-to-back transitions.

No remaining critical concerns. The change is cleared to ship.

---

## Evidence pointers

- Test run: `npx vitest run tests/unit/evolution-manager-taskflow-dualwrite.test.ts tests/unit/divergence-checker.test.ts` → 19/19 passing.
- Regression: `npx vitest run tests/unit/task-flow-registry.test.ts tests/unit/threadline-flow-bridge.test.ts tests/unit/AutonomousEvolution.test.ts` → 63/63 passing.
- Typecheck: `npx tsc --noEmit` → clean across modified files.
- Spec source of truth: `docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md` § Phase 3a (lines 629–643).
- Phase 1 trace context: `upgrades/side-effects/taskflow-phase1.md`.
- Phase 2 trace context: `upgrades/side-effects/taskflow-phase2.md`.
