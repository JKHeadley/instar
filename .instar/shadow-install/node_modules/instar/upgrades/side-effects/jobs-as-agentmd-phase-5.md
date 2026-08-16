# Side-effects review — Phase 5 (auto-migrate on update)

## What changed

`PostUpdateMigrator.autoMigrateLegacyJobsJson` is a new private step that runs once per update. It auto-invokes `jobsMigrate({ defaultAction: 'fork' })` when an agent has a legacy `jobs.json` AND has not yet completed-or-abandoned migration.

Decision matrix:

| Agent state on update | What happens |
|---|---|
| `jobs.json` absent (fresh install) | Skip silently — nothing to migrate |
| `.migration-complete.json` present | Skip with informational log line (operator already confirmed) |
| `.migration-abandoned.json` present | Skip with informational log line (operator chose rollback) |
| Otherwise (legacy state) | Run `jobsMigrate({ defaultAction: 'fork' })`; report migrated/forked counts; flag for operator to confirm via Dashboard |

The fork policy is the spec-mandated default for the auto-run path: any operator-edited default whose body differs from the shipped template is preserved verbatim under `.instar/jobs/user/<slug>.md`. Nothing is silently dropped.

## Side-effects review (mandatory gate)

### 1. Over-block / under-block

- **Over-block:** the carve-outs for `.migration-complete.json` and `.migration-abandoned.json` ensure the auto-run never re-fires after the operator has confirmed either path. The auto-run also writes a fresh `jobs.json.pre-migrate-<ts>` backup every time it executes — small disk cost (the backup is the rollback anchor for the SECOND interrupted update, in the unlikely event Phase 6 deprecation triggers another transition cycle).
- **Under-block:** the auto-run does NOT auto-write `.migration-complete.json` — that's the operator's Dashboard confirm. So the loader continues to read from BOTH `jobs.json` (legacy) AND `.instar/jobs/schedule/` (migrated) until operator confirms. The loader already handles the overlap (schedule shadows jobs.json on same-slug), so no behavioral drift.

### 2. Level-of-abstraction fit

`autoMigrateLegacyJobsJson` is a thin wrapper around `jobsMigrate`. It owns ONLY the decision-to-run logic (sentinel file checks). The actual migration is delegated. This keeps the per-layer responsibility clean: `jobsMigrate` is the migration authority, the auto-runner is the decision-to-run signal.

### 3. Signal-vs-authority compliance

The PostUpdateMigrator step is the signal ("the agent just updated, time to check migration state"). `jobsMigrate` is the authority on routing each entry. The operator (via Dashboard confirm) is the higher authority that flips `.migration-complete.json` — until that flips, the release-cut gate refuses to delete `jobs.json`. This Phase 5 PR does NOT shift authority; it just removes the need for the operator to invoke the CLI command manually.

### 4. Interactions

- **Phase 2 installBuiltinJobs** — runs BEFORE the auto-migrate step. So when auto-migrate fires, the shipped templates are already on disk at `.instar/jobs/instar/<slug>.md`. The body-match check in `jobsMigrate` compares jobs.json's `execute.value` against those just-installed templates — semantically correct.
- **Phase 3 jobsMigrate** — reused unchanged. The `defaultAction: 'fork'` argument preserves operator-edited bodies in `user/`.
- **Phase 4 Dashboard** — will surface the `migration-available` / `migration-completed` state via existing event stream. Phase 5 emits structured upgrade messages that the dashboard reads from the migration result.
- **Seamless Migration Guarantee invariants**:
  - Invariant 5 (one-button rollback) — `--abandon` flag on the CLI continues to work; the auto-runner respects the abandonment marker.
  - Invariant 6 (in-flight protection) — by construction, the auto-runner runs during `instar update apply`, BEFORE the new scheduler instance comes up. No jobs in flight at this moment.
  - Invariant 7 (transactional safety) — `jobsMigrate` is structurally safe (backup-first, idempotent). If SIGKILL hits mid-migration, the next boot will detect the partial state and either retry (no `.migration-complete.json`) or skip (operator wrote it).
  - Invariant 8 (telemetry) — every auto-run produces upgrade-message entries in the MigrationResult, which surfaces to the operator via the standard update-output channel.
  - Invariant 9 (fail-closed) — `jobsMigrate({ defaultAction: 'fork' })` cannot fail-closed because fork is a non-failure action. If a per-entry write fails, `outcome.errors` captures the specific failure, but the migration as a whole completes (the loader handles partial state). The auto-runner surfaces `outcome.errors` as `result.errors`.

### 5. Rollback cost

Trivial.
- Per-update: remove `autoMigrateLegacyJobsJson` call from `migrate()`. Existing agents either have `.migration-complete.json` (and stay completed) or have an unfinished migration state that the loader handles.
- Per-agent: `instar job migrate --abandon` (existing Phase 3 path) is the agent-side rollback.

### 6. What is NOT in this PR

- **Dashboard "migration ran on update" banner** — Phase 4. The auto-runner emits the structured upgrade message that the banner reads.
- **Interactive three-choice prompt** — Phase 4. Auto-run uses `--default-action=fork` non-interactively, which is the safer default.
- **In-flight scheduler check** — currently a no-op because update-apply happens before scheduler restart. If Phase 4 introduces a hot-reload path, the check becomes meaningful.

## Test coverage

`tests/unit/PostUpdateMigrator-autoMigrate.test.ts` — 5 cases:

1. Skips when jobs.json is absent
2. Skips when .migration-complete.json exists
3. Skips when .migration-abandoned.json exists
4. Runs jobsMigrate with --default-action=fork when no sentinels
5. Does NOT auto-write .migration-complete.json

All 5 pass locally. Lint + type-check pass.
