# Side-effects review — agentmd reconcile() boot lifecycle

## What changed

Implements INSTAR-JOBS-AS-AGENTMD spec §Runtime "Load lifecycle (boot)":
> reconcile() runs at boot, surfaces orphan/shadow/missing on boot. Output goes to Dashboard Issues card.

New module `src/scheduler/AgentMdReconcile.ts` exports `reconcileAgentMdTree({ stateDir })` returning a structured `ReconcileReport`. Five finding kinds:

- **orphan-manifest** (severity: error) — `<slug>.json` exists but no matching `.md`.
- **shadow-md** (severity: warning) — `<slug>.md` exists but no per-slug manifest.
- **missing-from-jobs-json** (severity: warning) — legacy `jobs.json` prompt entry has neither manifest nor `.md` (mid-migration).
- **staged-new** (severity: info) — `.md.new` or `.json.new` left over from a crashed atomic save (matches the helper landed in #211 echo/two-rename-atomicity, with a local-inlined scanner to avoid cross-PR dependency).
- **case-collision** (severity: error) — two slug files differ only by case under NFC normalization (matches the spec §Security Model "Case-collision" threat row).

New HTTP endpoint `GET /jobs/reconcile` returns the report. Dashboard Issues-card UI (Phase 4 rewrite, future) consumes the findings array.

## Side-effects review

### 1. Over-block / under-block

- **Over-block:** none. The reconciler is a read-only pure function. No state is modified.
- **Under-block:** the reconciler does NOT auto-remediate. It surfaces findings; the operator (via Dashboard Issues-card) decides whether to "Restore from git" / "Delete file" / "Add to schedule (disabled)" / "Apply staged" / etc. Per spec §Dashboard Error Surfaces.

### 2. Level-of-abstraction fit

Pure function. Reads the file system, returns structured findings. Severity is encoded in the data so the Dashboard's sort-by-severity rendering is one-line consumer code.

### 3. Signal-vs-authority compliance

The reconciler is purely a signal generator. It surfaces problems; it never decides what to do about them. Authority for remediation lives at the Dashboard layer (operator-confirmed actions) and at the loader (which already excludes orphan-manifest and case-collision entries from `jobs[]`).

### 4. Interactions

- **Phase 1a JobLoader** — already excludes case-collision entries from `jobs[]` (spec §Slug rules) and orphan-manifest entries (resolver fails). The reconciler surfaces these so the operator knows about excluded entries; the loader's exclusion behavior is unchanged.
- **AgentMdAtomicSave** (PR #211, in flight) — emits `.md.new` / `.json.new` files when SIGKILL'd mid-save; this PR's `staged-new` finding kind surfaces them. The scanner is inlined here pending #211 merge; a future cleanup PR can swap to the shared `listStagedNewFiles()` import.
- **Phase 4 Dashboard backend endpoints (PR #195)** — `/jobs/reconcile` is the third migration-state endpoint after `/jobs/migration-status`, `/jobs/migration-confirm`, `/jobs/migration-abandon`. Same auth surface (currently unauthenticated; #19 follow-up adds bearer-token gate).
- **Phase 4 Dashboard UI rewrite (future)** — consumes the findings array directly into the Issues card. Per spec §Dashboard Error Surfaces.

### 5. Rollback cost

Trivial. Pure function + thin HTTP wrapper. Removing both is one revert.

## Test coverage

10 cases in `tests/unit/scheduler/AgentMdReconcile.test.ts`:

1. Clean tree → zero findings
2. orphan-manifest detection (severity: error)
3. shadow-md detection (severity: warning)
4. missing-from-jobs-json detection (legacy mid-migration)
5. staged-new detection from interrupted atomic save
6. case-collision detection (case-sensitive FS only — gracefully skipped on macOS/Windows)
7. Non-prompt legacy entries (script/skill) excluded from missing-from-jobs-json
8. Multiple findings simultaneously with correct counts
9. Empty state directory → zero findings (fresh install)
10. Pure: calling twice produces identical output

All 10 pass locally. Lint + type-check pass.

## What is NOT in this PR

- Dashboard Issues-card UI (Phase 4 rewrite — separate effort).
- Auto-remediation actions (operator-confirmed only per spec).
- Bearer-token auth on `/jobs/reconcile` (follow-up task #19).
- Wiring reconcile into JobLoader's boot path to emit Dashboard events automatically (the HTTP endpoint serves the same data on-demand; a boot-time event emission is incremental polish).
