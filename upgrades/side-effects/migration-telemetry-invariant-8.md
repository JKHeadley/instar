# Side-effects review — Migration telemetry (invariant 8)

## What changed

Implements Seamless Migration Guarantee invariant 8 — "Every migrator run emits exactly one `migration.completed` or `migration.aborted` event to `.instar/ledger/job-runs.jsonl`."

New module + wiring:

- **`src/scheduler/MigrationLedger.ts`** — pure append/read helpers for migration events. Co-locates with the existing `JobRunHistory` ledger file (`.instar/ledger/job-runs.jsonl`). Uses a `kind` discriminator field so readers can distinguish migration events from regular `JobRun` rows.
  - `appendMigrationEvent(stateDir, event)` — best-effort append. Missing telemetry is degradation, not a release-blocker.
  - `readMigrationEvents(stateDir)` — filters out non-migration rows; tolerates malformed lines.
  - `findCompletedFor(stateDir, instarVersion)` — release-cut helper; returns the most recent `migration.completed` for a given version.
  - `normalizePerEntryAction(action)` — maps `jobsMigrate`'s richer perEntry vocabulary (`migrated-instar`, `forked-user`, …) to the spec's canonical set (`migrated | forked | renamed | skipped | failed | deferred-in-flight`).
- **`PostUpdateMigrator.autoMigrateLegacyJobsJson`** — assigns a `runId` + `startedAt` at the top of the method, then appends exactly one event on every code path:
  - On invariant-verified success: `migration.completed` (the LAST action per spec).
  - On `jobsMigrate` abort: `migration.aborted` with `abortReason = outcome.errors.join('; ')`.
  - On thrown exception: `migration.aborted` with `abortReason = err.message`.
- **`readBundledInstarVersion(packageRoot)`** helper reads `package.json` for the `instarVersion` field of the event.

## Side-effects review

### 1. Over-block / under-block

- **Over-block:** none. Telemetry writes are best-effort — a write failure does NOT block the migration or the update.
- **Under-block:** events are emitted from three code paths in `autoMigrateLegacyJobsJson` (success, aborted-by-jobsMigrate, thrown-exception). The Phase 3 CLI path (`instar job migrate`) does NOT currently emit telemetry — operator-initiated migrations are visible directly to the operator and don't need ledger surfacing. Adding CLI-path telemetry is a follow-up if Dashboard needs the unified view.

### 2. Level-of-abstraction fit

`MigrationLedger.ts` is a pure append/read facade. It does not depend on `JobRunHistory` (which has a richer in-memory schema). It writes to the same file format because the spec requires co-location. The discriminator field (`kind`) keeps the formats from confusing each other.

The PostUpdateMigrator integration is three short `appendMigrationTelemetry` calls — one per terminal path. Pure additive.

### 3. Signal-vs-authority compliance

The ledger is a write-only signal. The authority for "did migration complete for this release" is `findCompletedFor(stateDir, currentVersion)` returning non-null. The release-cut gate (future work) can call this; the Dashboard "Confirm migration complete" UI (future work) can surface it.

### 4. Interactions

- **`JobRunHistory.readLines()`** — currently casts every line to `JobRun`. After this PR, lines with `kind: 'migration.*'` will be returned as JobRun objects with `kind` set and most other JobRun fields undefined. Downstream consumers that index by `slug` (e.g., job-run dashboard) will see undefined and skip. Not a problem because (a) JobRun consumers filter on `slug` non-empty and (b) `kind` is a deliberate discriminator. A future PR can add the symmetric "skip non-JobRun rows" filter to `readLines()` if it surfaces unexpected behavior.
- **Phase 3 jobsMigrate CLI** — does NOT emit telemetry. Operator runs the CLI interactively; the telemetry surface is the auto-migrate (unattended) path. Adding CLI telemetry is straightforward but out of scope here.
- **Runtime invariant gate (PR #199)** — completed-event is written AFTER the gate passes. Aborted-event is written on rollback. Telemetry never lies about state.
- **Spec §Seamless Migration Guarantee** — invariant 8 is now structurally enforced for the auto-migrate path.

### 5. Rollback cost

Trivial. Three files; remove MigrationLedger.ts + revert the three append calls in PostUpdateMigrator.

## Test coverage

`tests/unit/scheduler/MigrationLedger.test.ts` — 8 cases:

1. `appendMigrationEvent` writes a parseable JSONL row
2. `readMigrationEvents` returns appended events in order
3. `readMigrationEvents` skips JobRun-shaped rows
4. `readMigrationEvents` tolerates malformed lines
5. `findCompletedFor` returns the most recent completion for a version
6. `findCompletedFor` returns null when only aborted events exist
7. Empty/missing ledger handled
8. `normalizePerEntryAction` maps every vocabulary

All 8 pass locally. Lint + type-check pass.

## What is NOT in this PR

- CLI-path telemetry (operator-initiated `instar job migrate` does not emit).
- Release-cut gate consuming `findCompletedFor`.
- Dashboard surface for migration events.
- JobRunHistory reader filtering — currently the existing reader returns migration-event lines as malformed-shaped JobRun objects; downstream consumers tolerate this today, but a future PR can tighten the type.
