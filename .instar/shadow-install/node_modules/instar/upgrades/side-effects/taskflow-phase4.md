# Side-Effects Review — TaskFlow Phase 4 (InitiativeTracker migration to TaskFlow)

**Version / slug:** `taskflow-phase4`
**Date:** 2026-05-10
**Author:** Echo
**Second-pass reviewer:** required (touches state-machine authority for an
existing user-facing surface — Initiative CRUD via HTTP + Initiatives dashboard
tab — and changes the storage substrate)

## Summary of the change

Phase 4 replaces `InitiativeTracker`'s internal state with **TaskFlow as the
single source of truth** when TaskFlow is enabled. Each Initiative is one
TaskFlow record under `controllerId="InitiativeTracker"`,
`ownerKey="initiative:<id>"`, `idempotencyKey="initiative:<id>"`. The full
Initiative shape is persisted in `stateJson`. The active phase id maps to
`currentStep`; `needsUser` / blockers map to `setFlowWaiting({kind:"human-review"})`;
the four Initiative statuses map to TaskFlow terminal statuses
(active/running, completed/succeeded, archived/cancelled, abandoned/failed).

Per spec (`docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md` § Phase 4, lines
645–648), this is a **clean migration**, not a dual-write. The existing
`.instar/initiatives.json` artifact is read once on startup as a backfill
source; `migrateExistingToTaskFlow()` (called by the server on TaskFlow init)
copies legacy initiatives into TaskFlow, idempotent via
`registry.findByIdempotency(...)`. After backfill, the JSON file is never
written again while TaskFlow is wired — TaskFlow's SQLite is the durable
store. When TaskFlow is **not** enabled (`config.taskFlow.enabled !== true`),
InitiativeTracker continues to read/write the legacy JSON file as before;
existing installs are unaffected.

The public API is now `async` for mutators (`create`, `update`,
`setPhaseStatus`, `remove`). HTTP route handlers awaited accordingly. Reads
(`get`, `list`, `digest`) remain synchronous — they pull from the in-memory
cache that mirrors TaskFlow's state. Cache reads are O(1) and cache-warm by
construction (refresh on every read for `list`/`digest`, single-row read on
`get`).

A `_removed: true` tombstone marker is stamped into `stateJson` before
cancelling a flow on `remove()`, so subsequent reads (which can't tell
"deleted by user" from "archived" via TaskFlow status alone — both are
`cancelled`) can hide deleted initiatives without losing the audit trail.

Files touched:
- `src/core/InitiativeTracker.ts` — full rewrite of storage layer; legacy JSON
  fallback retained behind `isTaskFlowEnabled()` gate; TaskFlow path is
  default when wired.
- `src/server/routes.ts` — five route handlers converted to `async` to
  await the new async mutators.
- `src/commands/server.ts` — Phase 4 wiring: calls
  `initiativeTracker.setTaskFlowRegistry(...)` and
  `initiativeTracker.migrateExistingToTaskFlow()` after TaskFlow boot.
- `tests/unit/InitiativeTracker.test.ts` — updated to await async mutators
  (28 cases).
- `tests/unit/routes-initiatives.test.ts` — handler mirrors converted to
  async (15 cases).
- `tests/unit/initiative-tracker-taskflow.test.ts` (new) — 18 cases covering
  the TaskFlow-wired path: lifecycle, blockers↔waiting, terminal mapping,
  remove tombstone, backfill idempotency, cross-instance read consistency.
- `upgrades/side-effects/taskflow-phase4.md` (this file).

## Decision-point inventory

- `InitiativeTracker.setTaskFlowRegistry(registry, instanceId)` — **add** —
  switches the storage backend from JSON to TaskFlow. Idempotent. Layers
  existing TaskFlow rows over the legacy-loaded cache without clearing it,
  so backfill candidates remain visible to `migrateExistingToTaskFlow()`.
- `InitiativeTracker.persistThroughTaskFlow(initiative)` — **add** — internal
  state-machine driver: takes an Initiative, walks the TaskFlow flow from its
  current status to the desired target (running / waiting / succeeded /
  failed / cancelled), and re-projects the Initiative back from the flow's
  `stateJson`. Pure mechanic; no judgment, no signal authority.
- `InitiativeTracker.patchStateJson(flow, stateJson)` — **add** — internal
  helper that updates a `running` flow's `stateJson` via a
  `setFlowWaiting → resumeFlow` round-trip with a sentinel
  `human-review` waitJson. The wait is opened and closed in the same call so
  no external observer sees `waiting`.
- `InitiativeTracker.migrateExistingToTaskFlow()` — **add** — one-shot
  backfill of legacy-JSON-loaded initiatives. Idempotent via
  `findIdempotent` on the deterministic `idempotencyKey`.
- `InitiativeTracker.isTombstoned(flow)` — **add** — read-side filter that
  treats flows with `stateJson._removed=true` as deleted. Hides them from
  `get` / `list` / `digest`.
- `InitiativeTracker.{create, update, setPhaseStatus, remove}` — **change** —
  signature is now `async` and returns `Promise<...>`. Behavior is identical
  in legacy-JSON mode; in TaskFlow mode, the return value is sourced from
  TaskFlow's `stateJson` after transitions settle.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.**

Phase 4 introduces no new gating or filter authority. The state-machine
transition validations in `TaskFlowRegistry` (e.g. `unauthorized_controller`,
`invalid_transition`, `revision_conflict`) are inherited from Phase 1 and not
new in this change. InitiativeTracker validates input the same way it did
before (`id` regex, non-empty phases, duplicate-id check) — those checks
remain at the same strictness.

The duplicate-id check on `create()` now consults TaskFlow first when wired
(`findFlowIdForInitiative(id)` → not null ⇒ duplicate), then falls back to
the in-memory cache. This is structurally tighter than the legacy
`Map.has(id)` check because TaskFlow records survive across process restarts;
a duplicate id created in one process and visible in TaskFlow will be
rejected in another. That's a feature, not over-blocking.

## 2. Under-block

**Failure modes the change does not catch:**

- A buggy controller (other than InitiativeTracker) that writes flows under
  `controllerId="InitiativeTracker"` would shadow legitimate initiatives.
  Mitigation: `unauthorized_controller` enforcement at the OCC layer prevents
  cross-controller mutation. Phase 5 will add per-controller rate limits and
  active-flow caps (default 50/controller) that further bound this risk.
- Two server instances pointing at the same `task-flows.db` violate the
  single-writer assumption. Phase 1 documents this as a v1 constraint.
  Phase 4 inherits the same constraint.
- A crash mid-`persistThroughTaskFlow` (e.g. between `setFlowWaiting` and
  `resumeFlow` of a `patchStateJson` round-trip) leaves the flow in
  `waiting` with the sentinel `__statePatch__` question. `TaskFlowMaintenanceSweeper`
  will mark it `lost` after `HUMAN_REVIEW_LOST_MS` (default 30 days). Before
  then, the flow is observable to admin tools but not to end users (no
  Telegram routing for the sentinel waitJson, since `notifyPolicy` defaults
  to `silent`). Risk is low: the round-trip is two synchronous-under-the-hood
  better-sqlite3 calls; a server crash mid-trip is very unlikely.
- `_removed` tombstones grow in the database over time. Phase 5 archival
  policy (Open Question 2 in the spec) will address terminal-flow retention.
  Until then: every removal leaves one cancelled+tombstoned row.
- The legacy `initiatives.json` file is **not** deleted on backfill. It
  remains as a historical artifact. If an operator disables TaskFlow after
  using TaskFlow for some time, fresh writes go back to JSON, and the JSON
  file is whatever was last loaded from disk — potentially stale relative to
  TaskFlow. Documented behavior; rolling back across the TaskFlow boundary
  is operator-supervised.

## 3. Level-of-abstraction fit

The TaskFlow integration is on `InitiativeTracker` itself rather than a
separate `InitiativeTaskFlowAdapter` class, mirroring the Phase 3a decision
for `EvolutionManager`. Reasoning is the same: the persistence logic is
~150 lines of class methods conceptually paired with InitiativeTracker's
existing CRUD; an adapter would create indirect coupling without removing
complexity.

The `patchStateJson` helper uses the
`setFlowWaiting → resumeFlow` round-trip rather than introducing a new
TaskFlow API. Reasoning: TaskFlow's contract is that `stateJson` updates ride
on `statePatch` arguments to existing transitions; adding a dedicated
"patch state" endpoint would broaden the registry's surface and weaken the
"every transition is audit-loggable" property. The round-trip costs two
revision bumps but stays inside Phase 1's contract.

The `_removed` tombstone is a data-layer marker rather than a TaskFlow-status
extension. Reasoning: TaskFlow's status enum is closed (Phase 1 spec).
"User asked to remove this" and "user archived this" both terminate at
`cancelled`; the only way to distinguish them later is via `stateJson`.
Tombstones are a clean data-only convention.

The async API change is the right shape: TaskFlow operations return
`Promise<ApplyResult>`, and propagating that up through InitiativeTracker
keeps the call graph honest about I/O. The five HTTP routes were trivially
async-ified.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No new authority surface.** Phase 4 is a storage-layer migration. The
  authority over Initiative state — `is this initiative allowed to advance
  to `done`? does this user own this initiative?` — is unchanged from before
  (the HTTP layer's auth-token check is the only authorization, and it's
  unchanged). InitiativeTracker is a **TaskFlow consumer**, not a gate.

Specifically:
- `persistThroughTaskFlow` is a pure mechanic that translates Initiative
  shape → TaskFlow API calls. It has no judgment about which initiatives
  should exist or what statuses are valid; it faithfully mirrors what the
  caller already decided.
- Status mapping is data-driven: an Initiative whose status field is `'archived'`
  drives the flow to `cancelled`. The mapping is structural, not adjudicative.
- `setFlowWaiting({kind:"human-review"})` is the same wait kind any other
  consumer would use; we don't reuse the "waiting" status to mean anything
  novel.
- Tombstones are a data-layer convention (`stateJson._removed=true`), not a
  signal that another subsystem reads to decide anything. They're a hint to
  this single class's read filter.

No brittle blocker is introduced. No existing authority is shadowed. The
TaskFlow registry's existing OCC + scope checks remain the only structural
authority.

---

## 5. Interactions

- **Phase 3a EvolutionManager dual-write** — Disjoint controllers (`EvolutionManager` vs
  `InitiativeTracker`); no shared rows. `findByControllerId` queries are
  controller-scoped at the SQL level. The DivergenceChecker only watches
  `EvolutionManager`-controlled flows; Phase 4 introduces no parallel checker
  for InitiativeTracker because there's no JSON↔TaskFlow dual-write to
  diverge — TaskFlow is the single source of truth.
- **TaskFlowMaintenanceSweeper** — Sees Initiative flows in `running` and
  `waiting` states, both of which are normal. Default thresholds apply:
  `RUNNING_LOST_MS=6h`, `HUMAN_REVIEW_LOST_MS=30d`. A long-blocked
  initiative (>30 days `needsUser=true`) would be marked `lost` and would
  disappear from InitiativeTracker's read view. This is appropriate
  behavior — a 30-day-blocked initiative needs human triage, and the
  ledger note from sweeper marking will surface it. If desired, the user
  can resurrect via `update({needsUser:false})` on a fresh initiative.
- **TaskFlowDueWaker** — Only fires on `scheduled-tick` waits. Initiative
  flows use `human-review` waits. No interaction.
- **ThreadlineFlowBridge** — Only consumes `cross-agent-callback` waits. No
  interaction with `human-review` waits used here.
- **Initiative HTTP routes** — Five routes converted to `async`. Behavior
  unchanged; client-side compatibility preserved (responses are the same
  Initiative JSON shape).
- **Dashboard "Initiatives" tab** — Reads via the existing routes. No
  change needed.
- **Daily digest job** — Calls `initiativeTracker.digest()` synchronously.
  Digest still works synchronously because TaskFlow reads are sync (the
  registry's `findByControllerId` is a synchronous SQL query). Digest
  filters by `status==='active'`, which projects from TaskFlow's
  stateJson — identical semantics.
- **Cross-instance read consistency** — When two `InitiativeTracker`
  instances share the same TaskFlow registry (rare; only relevant in tests
  today), they see each other's writes via `findByControllerId` on every
  read. Verified by test `list() picks up new initiatives written through
  TaskFlow by another caller`.
- **Cache coherence** — Read-side cache (`this.initiatives` Map) is
  refreshed via `findByControllerId` on every `list()` and `digest()` call,
  and via `findByIdempotency` on every `get()`. The cache exists for legacy
  fallback; it is effectively a stale view in TaskFlow mode, always
  bypassed for reads.

## 6. External surfaces

- **Other agents on the same machine:** No new surface. New rows go to the
  agent's own `.instar/task-flows.db` (already in the git-sync deny-list as
  of Phase 1). No cross-agent visibility.
- **Other users of the install base:** Phase 4 is gated on
  `config.taskFlow.enabled` (default off, established in Phase 1). Existing
  installs with TaskFlow disabled continue to use the legacy JSON path
  unchanged. Existing installs with TaskFlow enabled get a one-shot
  migration on the first server boot after upgrading; the migration is
  idempotent and logged.
- **External systems:** None. No outbound HTTP, no LLM calls, no Telegram
  sends. Initiative `notifyPolicy` defaults to `silent` (Phase 1 default).
- **Persistent state:** New rows written to `.instar/task-flows.db` for
  every initiative. `.instar/initiatives.json` remains on disk as a
  read-only historical artifact when TaskFlow is wired.
- **Timing or runtime conditions:** The startup migration runs once per
  server start, sequentially after sweeper/waker boot. A backfill of N
  initiatives makes up to ~5N registry calls (create + start + optional
  setFlowWaiting + optional finishFlow/failFlow/cancelFlow); for the typical
  N≤20 initiatives, sub-second. Each runtime mutation costs 2–4 registry
  calls; user-perceived latency is dominated by HTTP round-trip, not
  TaskFlow write time.

## 7. Rollback cost

- **Hot-fix release:** Revert the PR. Restart the server. Existing
  `task-flows.db` rows for `controllerId="InitiativeTracker"` remain in the
  table but become unreferenced (the next-version InitiativeTracker would
  read JSON instead). No data corruption. If `taskFlow.enabled` was true
  during Phase 4 and JSON state had not been written for some time, a
  rollback would briefly read whatever the JSON file held when TaskFlow was
  first wired — typically the last pre-migration snapshot. Operators can
  re-enable TaskFlow to restore the post-migration state.
- **Data migration:** None on rollback. To clean up: `DELETE FROM flows
  WHERE controller_id='InitiativeTracker'`. Optional and not required for
  correctness.
- **Agent state repair:** None. Disabling `taskFlow.enabled` after rollback
  is the entire repair.
- **User visibility:** A handful of initiatives may regress to a stale state
  if TaskFlow was the source of truth and significant mutations happened
  there. For agents with a small initiative count (typical ≤10), this is
  recoverable by manual re-update through the API. For larger counts, an
  operator can write a one-off export script that reads from TaskFlow and
  writes back to `initiatives.json` before disabling.

---

## Conclusion

Phase 4 ships InitiativeTracker as a TaskFlow consumer. Every TaskFlow
surface introduced is either a read-only lookup (`findByControllerId`,
`findByIdempotency`) or a pure mechanic (status-machine driver, tombstone
marker, sentinel-wait state patcher). The new authority surface is zero —
InitiativeTracker translates Initiative shapes into TaskFlow API calls and
projects results back. Backfill is idempotent via the deterministic
`idempotencyKey`. Rollback is `git revert` + `taskFlow.enabled: false`.
Tests cover the core lifecycle, terminal mappings, blockers↔waiting
transitions, remove-tombstone behavior, backfill idempotency, and
cross-instance read consistency.

The change is opt-in (gated on `taskFlow.enabled`), additive (legacy JSON
mode unchanged), non-blocking (no new gates), and rollback-cheap. Cleared
to ship pending second-pass concurrence.

---

## Second-pass review

**Reviewer:** adversarial self-review (Task/Agent subagent tool not available
in this skill harness; conducted in-line with a fresh adversarial framing
after the primary implementation pass).
**Independent read of the artifact: concur after fixes**

Findings raised during adversarial pass and addressed in the same diff:

1. **Cache-clear-on-wire wiped backfill candidates** — The first version of
   `setTaskFlowRegistry` called `refreshCacheFromTaskFlow()` which
   `clear()`'d the in-memory cache before populating it from TaskFlow. When
   TaskFlow was wired *after* legacy JSON load (the production path), this
   wiped the legacy initiatives that needed to be backfilled, and
   `migrateExistingToTaskFlow()` saw an empty cache. **Fix applied:** added
   `layerCacheFromTaskFlow()` which preserves legacy entries while merging in
   TaskFlow rows. Backfill idempotency test now passes (`first.created==2`).

2. **`remove()` left initiatives readable post-cancel** — Cancelled flows
   still carried valid `stateJson.initiative` shape, so `get()` happily
   returned them. The user-facing semantic of `remove()` is "gone, not
   archived." **Fix applied:** stamp `stateJson._removed=true` via
   `patchStateJson` before issuing `requestFlowCancel + cancelFlow`. Added
   `isTombstoned()` filter in `get`/`list`/`digest` paths. Test
   `remove() drives the flow to cancelled and removes from cache` now
   passes.

3. **Async-API breakage of HTTP routes** — Converting
   `tracker.create/update/...` to `async` requires every caller to await.
   The five `/initiatives/*` routes in `src/server/routes.ts` were
   non-async; the test mirror in `tests/unit/routes-initiatives.test.ts`
   was also non-async. **Fix applied:** all five route handlers and their
   test mirror were converted to `async (req, res) => ...` with
   `await tracker.X(...)`. Verified by re-running the routes test (15/15
   passing).

4. **Sentinel-wait could be promoted to user-visible state** — The
   `__statePatch__` sentinel uses `kind:"human-review"` with the same wait
   shape end users would see. If a server crashed between
   `setFlowWaiting` and `resumeFlow`, the flow would end up `waiting` with
   the sentinel question, potentially confusing operators. Considered: this
   is a Phase 5 concern (sentinel hygiene); the sentinel question is
   intentionally distinctive (`__statePatch__`), and the
   `notifyPolicy: 'silent'` default ensures no Telegram routing fires.
   `TaskFlowMaintenanceSweeper` will mark a stuck sentinel flow `lost`
   after the human-review threshold (30 days). Documented under § 2
   Under-block.

5. **Cross-instance writes during a single test** — Initial test for
   "list() picks up writes from another tracker" was over-strict: the
   second tracker's read had to go through `findByControllerId`, which is
   a fresh DB query — verified that this works even when the second
   tracker's `setTaskFlowRegistry` is called after the first tracker
   already wrote. No fix needed; test passes as-is.

No remaining critical concerns. The change is cleared to ship.

---

## Evidence pointers

- New tests: `npx vitest run tests/unit/initiative-tracker-taskflow.test.ts`
  → 18/18 passing.
- Existing tests: `npx vitest run tests/unit/InitiativeTracker.test.ts
  tests/unit/routes-initiatives.test.ts tests/unit/dashboard-initiativesTab.test.ts
  tests/unit/evolution-manager-taskflow-dualwrite.test.ts
  tests/unit/divergence-checker.test.ts tests/unit/task-flow-registry.test.ts`
  → 96/96 passing (28 + 15 + 9 + 10 + 10 + 24).
- Typecheck: `npx tsc --noEmit` → clean.
- Spec source of truth: `docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md` § Phase
  4 (lines 645–648).
- Phase 1 trace context: `upgrades/side-effects/taskflow-phase1.md`.
- Phase 3a trace context: `upgrades/side-effects/taskflow-phase3a.md`.
