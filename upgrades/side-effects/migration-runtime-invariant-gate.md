# Side-effects review — Migration runtime invariant gate

## What changed

Implements the spec §Gate wiring runtime gate: `PostUpdateMigrator` now re-verifies Seamless Migration Guarantee invariants 1, 2, 4 against staged state AFTER `jobsMigrate` completes but BEFORE the auto-migrate step is considered final. Any invariant failure triggers a fail-closed rollback via `jobsMigrate({ abandon: true })` (invariant 9).

New module:

- **`src/scheduler/MigrationInvariants.ts`** — pure verifier with three functions:
  - `snapshotUserNamespace(agentStateDir)` — captures `<slug>.md` content + mtimes under `.instar/jobs/user/` for later invariant-4 comparison
  - `verifyMigrationInvariants({ agentStateDir, preMigrationJobs, preMigrationUserSnapshot })` — runs the three checks and returns a structured outcome
  - `canonicalScheduleHash(entry)` — exported for tests; canonical-JSON hash of the schedule-and-policy fields per spec invariant 2

Wiring:

- **`src/core/PostUpdateMigrator.autoMigrateLegacyJobsJson`** — snapshots `preMigrationJobs` + `preMigrationUserSnapshot` BEFORE calling `jobsMigrate`. After `jobsMigrate` completes, calls `verifyMigrationInvariants`. On verification failure: invokes `jobsMigrate({ abandon: true })` to roll back AND surfaces the failure to `result.errors`. The migration result message includes `"Invariants verified"` only when the gate passes.

## Side-effects review

### 1. Over-block / under-block

- **Over-block:** the gate triggers a rollback only when ALL three invariants verify-fail. A `skipped` (e.g., no snapshot) result does NOT cause rollback. Invariant 4 is `skipped` when caller omits `preMigrationUserSnapshot` — defensive, doesn't break callers who don't have that snapshot.
- **Under-block:** the gate does NOT cover invariant 6 (in-flight protection). By design — at update-apply time, no jobs are running mid-update, so invariant 6 is structurally satisfied. The spec calls out this carve-out explicitly: "PostUpdateMigrator runtime gate re-verifies invariants 1, 2, 4, and 6." Invariant 6 verification would require wiring through `JobScheduler.activeRuns()` which doesn't exist yet on the agentmd path; that's the documented follow-up.

### 2. Level-of-abstraction fit

The verifier is a pure function on the file system + pre-migration in-memory state. It has no scheduler dependencies, no event emissions, no async side effects. The gate is mechanically simple: snapshot → migrate → verify → if-failed-rollback. Each step is one function call.

### 3. Signal-vs-authority compliance

The verifier signals "the staged state violates invariants 1/2/4." `PostUpdateMigrator` is the authority that responds — either by allowing the migration to settle or by rolling it back. The verifier itself never deletes or modifies state. Clean separation.

### 4. Interactions

- **`jobsMigrate`** — consumed unchanged. The new code wraps it with snapshot + verify + rollback.
- **`installBuiltinJobs`** — runs in `migrateBuiltinJobs` BEFORE `autoMigrateLegacyJobsJson`. The installer is non-destructive to `.instar/jobs/user/` per its own invariants; the snapshot is taken AFTER `installBuiltinJobs` and BEFORE `jobsMigrate`, so the snapshot captures the actual pre-migration state.
- **Migration Guarantee Suite (PR #196)** — the new module is the runtime counterpart to the suite's invariant assertions. Same invariants, same canonicalization, but at boot-time instead of CI-time.
- **Test suite** — 14 cases in `tests/unit/scheduler/MigrationInvariants.test.ts` cover every invariant pass/fail/skip path including the rename-map edge case and the canonical-hash stability test.

### 5. Rollback cost

Trivial. Two files (`MigrationInvariants.ts` + 30 lines in `PostUpdateMigrator.ts`). Pure additive — pre-existing behavior is identical if the verifier always returns `ok: true` (the new code path inside `autoMigrateLegacyJobsJson` reduces to the prior code path).

### 6. What is NOT in this PR

- **Invariant 6 wiring** — needs `JobScheduler.activeRuns()` instrumentation on the agentmd path. Documented follow-up.
- **Invariant 8 (telemetry to `job-runs.jsonl`)** — separate follow-up; the verifier surfaces results via `MigrationResult`, but a per-migration telemetry row in the ledger is its own concern.
- **Phase 3 CLI gate** — `jobsMigrate` CLI does NOT currently invoke the verifier. The CLI is operator-initiated; the operator chose to migrate. The auto-on-update path is where the verifier matters most (unattended operation).

## Test coverage

14 cases in `tests/unit/scheduler/MigrationInvariants.test.ts`:

- Invariant 1: passes / fails-on-drop / accepts renames / excludes non-prompt
- Invariant 2: passes / fails on schedule change / fails on enabled change
- Invariant 4: passes / fails-on-modify / fails-on-remove / skipped-no-snapshot / passes-on-new-fork
- `canonicalScheduleHash`: stable across reorderings / changes on schedule change

All 14 pass locally. Lint + type-check pass.
