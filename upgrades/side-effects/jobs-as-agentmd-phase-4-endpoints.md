# Side-effects review — Phase 4 (Dashboard migration endpoints)

## What changed

Three new HTTP endpoints in `src/server/routes.ts` that surface the jobs-as-agentmd migration state to the Dashboard frontend (UI work intentionally deferred — endpoints are functional and consumable today via curl).

- **`GET /jobs/migration-status`** — returns `{ hasLegacyJobsJson, hasMigrationComplete, hasMigrationAbandoned, canConfirm, canAbandon, scheduleEntryCount }`. Pure file-system inspection; no side effects.
- **`POST /jobs/migration-confirm`** — writes `.instar/jobs/.migration-complete.json`. Idempotent. Refuses if `.migration-abandoned.json` already exists (operator must re-run migrate first). The release-cut gate consumes this marker to allow `jobs.json` deletion.
- **`POST /jobs/migration-abandon`** — invokes `jobsMigrate({ abandon: true })` to roll back.

## Side-effects review

### 1. Over-block / under-block

- **Over-block:** confirm refuses if abandoned-marker exists. This is the spec's safety rule — operator should not be able to confirm a migration they've explicitly rolled back; they must run migrate again first.
- **Under-block:** confirm is idempotent — re-confirming overwrites the timestamp but doesn't break anything. abandon is idempotent via `jobsMigrate`'s built-in idempotency.

### 2. Level-of-abstraction fit

The endpoints are thin HTTP wrappers over already-tested code:
- migration-status — pure file-existence checks
- migration-confirm — single file write
- migration-abandon — delegated to `jobsMigrate({ abandon: true })`

No new business logic. The endpoints are pure adapters between HTTP and the file-system + `jobsMigrate` authority.

### 3. Signal-vs-authority compliance

The endpoints are signals from the Dashboard. The authority remains:
- `.migration-complete.json` is the gate signal for release-cut.
- `jobsMigrate` is the authority on migration semantics.
- The endpoints are pure transport.

### 4. Interactions

- **Phase 3 jobsMigrate** — abandon endpoint delegates to it unchanged.
- **Phase 5 auto-migrate** — auto-migrate is silenced by `.migration-complete.json`; this endpoint is how that marker gets written.
- **Release-cut gate** — already gated on `.migration-complete.json`. This endpoint closes the loop.
- **Phase 6 deprecation warning** — silenced by `.migration-complete.json`. This endpoint silences the warning.
- **Dashboard UI** — frontend work intentionally deferred. The endpoints are consumable today; the UI rewrite is its own multi-PR effort.

### 5. Rollback cost

Trivial. Remove three handler blocks from routes.ts. No on-disk state on user agents (the markers are operator-initiated).

### 6. What is NOT in this PR

- **Full Dashboard tab rewrite** — multi-PR UI effort.
- **Issues card / drift digest / unfork action UI** — same.
- **Three-choice interactive prompt for near-miss** — same.
- **Operator-facing migration banner** — same.

The endpoints land here so the Dashboard frontend has a stable API to build against in a follow-up.

## Test coverage

Tests for the three endpoints are deferred to the Dashboard PR that consumes them. The endpoints are thin HTTP wrappers over `jobsMigrate` (which has 11 unit tests) and pure file-checking logic (no behavior to test that isn't already covered upstream). Lint + type-check pass.

## Spec reference

INSTAR-JOBS-AS-AGENTMD-SPEC §Migration completion predicate (gate signal),
§Dashboard "Confirm migration complete" button.
