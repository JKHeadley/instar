# Side-Effects Review — TaskFlow Phase 1 (skeleton + storage + sweeper + waker)

**Version / slug:** `taskflow-phase1`
**Date:** 2026-05-09
**Author:** Echo
**Second-pass reviewer:** required (idempotency checks + state-machine authority surface)

## Summary of the change

Imports OpenClaw's TaskFlow primitive into instar as a new SQLite-backed registry of durable, optimistic-concurrency multi-step job records. Phase 1 ships only the plumbing: types, store, registry surface (createFlow / startStep / setFlowWaiting / resumeFlow / finishFlow / failFlow / cancel / markLost / pingFlow / find* lookups), an hourly maintenance sweeper that marks stranded flows `lost`, and a minute-tick due-waker for `scheduled-tick` waits. No business consumers — `EvolutionManager`, `InitiativeTracker`, and `ThreadlineFlowBridge` are integrated in later phases.

Files touched:
- `src/tasks/task-flow-types.ts` (new) — types, zod schemas, error class, default thresholds
- `src/tasks/task-flow-registry.store.sqlite.ts` (new) — SQLite store with `BEGIN IMMEDIATE` writes
- `src/tasks/TaskFlowRegistry.ts` (new) — registry surface, OCC apply, EventBus, audit notes
- `src/tasks/TaskFlowMaintenanceSweeper.ts` (new) — hourly lost-eligibility scan
- `src/tasks/TaskFlowDueWaker.ts` (new) — minute-tick scheduled-tick resume
- `tests/unit/task-flow-registry.test.ts` (new) — 24 vitest cases (OCC, transitions, sweeper, waker, find lookups, redaction)
- `src/server/routes.ts` — adds `RouteContext.taskFlowRegistry` + admin HTTP routes (`POST /flows`, `GET /flows/:id`, mutation routes, `GET /flows/waiting`, `POST /flows/:id/ping`)
- `src/server/AgentServer.ts` — adds `taskFlowRegistry` option, propagates to `RouteContext`
- `src/commands/server.ts` — opt-in instantiation gated on `config.taskFlow.enabled`; sweeper + waker started with `unref()`'d timers
- `.gitignore` — adds `.instar/task-flows.db*` (per-machine, may contain user PII)
- `upgrades/side-effects/taskflow-phase1.md` (this file)

## Decision-point inventory

- `TaskFlowRegistry.applyOcc` (registry-internal) — **add** — gates every mutation on `expectedRevision`; rejects `not_found / revision_conflict / already_terminal / invalid_transition`. Storage-mechanics, not judgment.
- `TaskFlowMaintenanceSweeper.isLostEligible` — **add** — deterministic threshold rule per (status × wait-kind), configurable via `config.taskFlow.thresholds`. Marks flows `lost` via the registry's `markLost` (reserved-controller writer per spec § Design Principles 6).
- `TaskFlowRegistry.maybeNotify` — **add** — fires `taskflow:notify` events. Phase 1 ships metric-only; no actual messages sent. No block/allow surface.
- `WaitJson` zod validation — **add** — strict-on-write structural validation at the API edge. Hard-invariant validation, not judgment (signal-vs-authority exemption "Hard-invariant validation").
- `createFlow` idempotency-key uniqueness — **add** — mechanics for retry-safe creates; not judgment.
- HTTP route auth — **pass-through** — global `authMiddleware` already protects `/flows*`; no new auth surface.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The OCC mutation surface rejects:
- Stale `expectedRevision` → `409 revision_conflict` with the current record body. Caller's documented retry path is "re-read flow, retry with new revision." A controller that lost a race retries; nothing legitimate is permanently rejected.
- Mutations on terminal flows → `410 already_terminal`. By definition no legitimate work happens on terminal flows.
- `setFlowWaiting` for a `reply` wait whose `(controllerId, channel, threadId, peer)` already has an active wait → `wait_collision`. The spec calls for this — preventing two flows from racing to consume the same Telegram-thread reply. If a controller legitimately wants to "wait for whichever reply lands first", that is NOT v1 semantics; v1 says one flow per tuple.
- `WaitJson` validation rejects malformed inputs (e.g. negative `dueAt`, missing `correlationId`). Edge structural validation, not judgment.

The sweeper marks `lost` only after configured thresholds. Defaults are deliberately conservative (running 6h, reply 7d, human-review 30d, scheduled-tick never). All thresholds are configurable in `.instar/config.json` under `taskFlow.thresholds`. A controller that legitimately runs 5 hours of work without heartbeating could be incorrectly marked `lost`; the documented contract is "ping at least every `HEARTBEAT_INTERVAL_MS` (60s)." The 6h threshold gives a 360× heartbeat-failure margin before the sweeper fires.

## 2. Under-block

**What failure modes does this still miss?**

- A flow that runs >6h with regular pings continues running indefinitely. By design — `pingFlow` is the heartbeat-renewal mechanism. The sweeper does not enforce a ceiling on legitimate work.
- Cross-store dangling foreign keys: `cancelRequestedBy.id` may point at a user who has been removed; we don't validate. v1 explicitly tolerates dangling refs (see WikiClaim spec for the analogous policy).
- A buggy controller can `finishFlow` with `result: { ... }` that exceeds 64 KiB only if the existing `stateJson` plus result merger pushes it over. We validate post-merger, so this is detected.
- HTTP body fields are normal JSON — a caller that posts `principal: null` gets `422 invalid_argument`. Anyone with the bearer token can pass `scope: 'admin'` and bypass controllerId checks. v1 is single-process / loopback-only; admin scope from a token-holder is the intended trust model.
- Sweeper-vs-controller race: spec § Threat Model documents this. A controller that misses pings AND has unfinished side effects emits a SharedStateLedger note for human follow-up. The registry rejects the controller's late `finishFlow` with `already_terminal` (the sweeper's `markLost` won the OCC race).
- **Quota enforcement is deferred** — spec Phase 5 adds per-controller flow-creation rate limits and max-active-flows-per-controller. Phase 1 does not enforce these. A buggy controller could create a runaway number of flows; until Phase 5 ships, mitigation is monitoring (`flows_status_updated_at` index makes a "how many flows are running for X" query cheap).

## 3. Level-of-abstraction fit

This is plumbing — a typed, durable state machine for in-flight work. It belongs at the same layer as `JobScheduler` and `InitiativeTracker`. It does NOT replace either: JobScheduler runs cron-style recurrences, InitiativeTracker tracks multi-phase work without typed waits or OCC. TaskFlow fills the gap for "single-instance multi-step jobs with typed, durable waits."

The maintenance sweeper is the right level: it reads structural state (heartbeat timestamps, wait kinds, configured thresholds) and applies a deterministic rule. It does NOT inspect `stateJson` content (which would require domain knowledge it shouldn't have). The threshold rule lives in config, so a future smarter-authority migration could replace it without restructuring (signal-shape → authority-consumer evolution is preserved).

The HTTP API is intentionally minimal. Production controllers run in-process inside the server and call the registry directly; the HTTP surface exists for admin/debugging and out-of-process tooling.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No** — this change has no block/allow surface in the judgment sense. Every "rejection" is either:
  - Hard-invariant structural validation at the API edge (zod, size limits, type-check), which the principle explicitly exempts ("Hard-invariant validation");
  - State-machine mechanics (terminal status, OCC revision, controllerId match), which is not a judgment about meaning or intent;
  - Deterministic threshold mechanics (heartbeat-stale, dueAt-passed) operating on numeric timestamps with configurable thresholds.

The maintenance sweeper specifically: it is the *enforcement mechanic* for the lost-eligibility rule. It does not interpret what work the controller is doing; it counts seconds since heartbeat. The accompanying SharedStateLedger note is *audit*, decoupled from authority — humans review notes; the note does not gate any action.

The notification dispatch surface (`TaskNotifyPolicy`) emits messages to topics. It does NOT decide whether a message is legitimate; that belongs to the existing `MessagingToneGate`. Phase 5 wiring will route notifications through `TelegramAdapter.send`, which already runs through the tone gate. Phase 1 ships metric-only emission to keep the tone-gate seam well-defined.

No brittle authorities introduced.

## 5. Interactions

- **Shadowing**: TaskFlow does not shadow `JobScheduler` (cron-recurrence) or `InitiativeTracker` (multi-phase) — they cover different use cases. EvolutionManager / DispatchExecutor will migrate to TaskFlow in Phases 3–5; until then, they continue to write to their own JSONL files. Phase 3 adds a `DivergenceChecker` for the dual-write window.
- **Double-fire**: The maintenance sweeper and the due-waker operate on disjoint flow sets (sweeper excludes `wait_kind='scheduled-tick'`; waker only handles that kind). They cannot both fire on the same flow.
- **Races**: `pingFlow` is OCC-exempt by design (spec § Heartbeat contract). It uses `WHERE flow_id=? AND status='running'` and rebinds `controllerInstanceId` on every successful call — this is the documented re-attach-after-restart mechanism. A concurrent step-advance would fail pingFlow's status check (status no longer 'running' inside the transaction), which the registry handles by re-reading and throwing `invalid_transition`. Sweeper-vs-controller races are documented in § Threat Model.
- **Feedback loops**: The sweeper emits SharedStateLedger notes; the ledger does not feed back into TaskFlow. The notification surface emits `taskflow:notify` events that Phase 5 routes through TelegramAdapter; that send path does not write back to TaskFlow.
- **Cache coherence**: The in-process LRU cache is updated AFTER `COMMIT` (registry's `applyOcc`). On COMMIT failure the cache entry is invalidated (deleted), so the next read forces a SQLite reload. Single-writer (the server process) means the cache is coherent by construction.

## 6. External surfaces

- **Other agents on the same machine**: None directly. Other agents do not share the TaskFlow DB. The DB file is on the git-sync deny-list (`.gitignore` updated).
- **Other users of the install base**: New module is opt-in via `config.taskFlow.enabled` (default off). Existing installs continue to work unchanged. Even when enabled, no existing routes / behaviors change.
- **External systems**: None. No outbound HTTP, no LLM calls, no Telegram sends in Phase 1 (notification dispatch ships at metric-emission level only).
- **Persistent state**: New SQLite file `.instar/task-flows.db` (+ WAL/SHM) created on first use. Backup System rotation already covers `.instar/*.db` patterns where applicable. Cross-machine sync explicitly OUT of v1 scope (spec § Privacy / sync exposure).
- **Timing or runtime conditions**: Sweeper runs hourly; due-waker runs every minute. Both timers `unref()` so they never keep the process alive on shutdown. Server restart re-attaches via the natural `pingFlow` rebind path; no special restart logic needed.

## 7. Rollback cost

- **Hot-fix release**: Pure additive change. Rollback is `git revert <pr-merge-commit>`; ship as next patch. The opt-in `config.taskFlow.enabled` flag means a partial rollback path also exists: set the flag to `false` in `.instar/config.json` and the registry won't instantiate (HTTP routes return `503 taskflow_not_enabled`).
- **Data migration**: None on rollback. The `.instar/task-flows.db` file is local, ignored by git, and contains no data any other subsystem depends on. Operators can safely delete it after rollback if they want a clean reinstall.
- **Agent state repair**: None. No existing agent has any flow records yet (Phase 1 has no producers). Reset is a no-op.
- **User visibility**: None during rollback window. No user-facing surface in Phase 1.

---

## Conclusion

Phase 1 ships TaskFlow as opt-in plumbing: types, SQLite store, registry surface, hourly sweeper, minute-tick waker, admin HTTP routes, and 24 unit tests covering OCC + transitions + sweeper + waker + find-lookups + redaction. The change has no block/allow judgment surface — every "rejection" is structural validation, state-machine mechanics, or deterministic threshold mechanics, all of which the signal-vs-authority principle exempts. The notification surface is wired but stubbed at metric-emission only, preserving the seam where Phase 5 will route through the existing tone-gate authority.

The change is opt-in (default off), additive (no existing behavior modified), and rollback-cheap (revert + flag flip). Cleared to ship pending second-pass concurrence.

---

## Second-pass review

**Reviewer:** independent code-audit subagent (general-purpose)
**Independent read of the artifact: concur**

The artifact's claims match the code: (1) `applyOcc` updates the cache only after `withWriteTransaction` returns post-COMMIT; (2) `findSweeperCandidates` filters `wait_kind != 'scheduled-tick'` and `findWaitingDue` filters `wait_kind='scheduled-tick'`, making the sweeper/waker sets provably disjoint; (3) `createFlow` lookup-then-insert runs inside `BEGIN IMMEDIATE` against a `(controller_id, owner_key, idempotency_key)` PRIMARY KEY, so duplicate keys return the existing flow with `created:false`; (4) `maybeNotify` increments local counters and emits an EventEmitter event but performs no outbound send; (5) the sweeper's `isLostEligible` is pure deterministic threshold arithmetic on numeric timestamps with config-overridable thresholds — a state-machine mechanic, not judgment, properly exempt under signal-vs-authority §"Hard-invariant validation" / §"Idempotency keys"; (6) `setFlowWaiting`'s `wait_collision` is uniqueness-mechanic on (controllerId, channel, threadId, peer), matching the spec's v1 semantics. No brittle blocking authority is introduced; rollback is revert + flag flip, and Phase 1 has no producers yet.

---

## Evidence pointers

- Test run: `npx vitest run tests/unit/task-flow-registry.test.ts` → 24/24 passing (135ms).
- Typecheck: `npx tsc --noEmit` → clean across modified files.
- Route-completeness test: `npx vitest run tests/unit/route-completeness.test.ts` → 9/9 passing. Catch blocks in new TaskFlow routes guard with `if (err instanceof Error)` to satisfy the routes-source invariant (every `catch (err)` paired with an `instanceof Error` check).
- Spec source of truth: `docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md` (Convergence: 2026-05-07; rounded through three review passes).
- OpenClaw provenance: commit `f482e4d335`, files `src/tasks/task-flow-registry.ts:376-586`, `task-flow-registry.types.ts:14-43`, `task-flow-registry.store.sqlite.ts:361-371`.
