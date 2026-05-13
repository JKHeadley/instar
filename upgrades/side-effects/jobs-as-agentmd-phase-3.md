# Side-effects review — Phase 3 (`instar jobs migrate`)

## What changed

`instar job migrate` ships as the operator-initiated path for converting a legacy `jobs.json`-only agent to the new per-slug-manifest layout. Idempotent. Reversible via `--abandon`. Non-destructive on `jobs.json` (only writes a backup and the new `.instar/jobs/...` tree).

New files:

- **`src/commands/jobMigrate.ts`** — pure function `jobsMigrate(opts)`. Reads `jobs.json`, classifies each entry against the shipped templates (body-match SHA-256 with normalize), writes per-slug bodies to `.instar/jobs/instar/` (for matched defaults) or `.instar/jobs/user/` (for user jobs and forked defaults), writes per-slug manifests to `.instar/jobs/schedule/`, and writes a backup at `.instar/jobs.json.pre-migrate-<ts>`.
- **CLI subcommand** — `instar job migrate [--default-action=fork|rename|skip|fail] [--report] [--abandon]`. Mirrors the spec's `instar jobs migrate` invocation contract.
- **11 unit tests** — `tests/unit/commands/jobMigrate.test.ts`.

Behavior matrix:

| Pre-migration entry shape | Classification | What gets written |
|---|---|---|
| Slug ∈ shipped + body matches (normalize SHA-256) | `migrated-instar` | per-slug manifest only (body lives in `src/scaffold/templates/jobs/instar/`) |
| Slug ∈ shipped + body differs | `near-miss-default` + `--default-action` | fork to user OR rename to `<slug>-user` OR skip OR abort (`fail`) |
| Slug ∉ shipped | `kept-user` | per-slug body in `user/` + manifest |
| `execute.type !== 'prompt'` (script/skill) | `skipped` | nothing (legacy path keeps them) |

## Side-effects review (mandatory gate)

### 1. Over-block / under-block

- **Over-block:** none on first migration. `--default-action=fail` (the default) is the safety-first choice — it refuses to write ANY partial state if a near-miss is detected, leaving `jobs.json` untouched. The operator must explicitly choose fork/rename/skip via flag (or via the future Dashboard interactive prompt) to proceed past a near-miss.
- **Under-block:** the script does NOT auto-write `.migration-complete.json`. The release-cut gate (spec §Migration completion predicate) requires the operator to confirm via Dashboard. Phase 3's responsibility ends at "all the new files are in place." Phase 4 builds the confirm UI.

### 2. Level-of-abstraction fit

`jobsMigrate` is a pure function on the file system + a structured outcome record. It DOES NOT invoke the scheduler, DOES NOT emit state events, DOES NOT modify `jobs.json` (only reads + backs up). This keeps it testable in a synthetic workspace and lets Phase 5's PostUpdateMigrator wrap it cleanly with auto-run + Dashboard banner emission.

The destructive operations (`--abandon` rm of `schedule/` and `instar/`; old abandonment marker cleanup) route through `SafeFsExecutor.safeRmSync` / `safeUnlinkSync` with explicit operation strings.

### 3. Signal-vs-authority compliance

The CLI sub-command is a signal (operator says "I want to migrate"). The migration script is the authority on routing each entry (does the slug+body match a shipped default? → which destination?). The release-cut gate is the higher authority that will eventually allow `jobs.json` to be deleted. This PR ships the signal + the routing; Phase 4 ships the operator-confirm step that flips the release-cut gate's check from "no" to "yes."

### 4. Interactions

- **Phase 1a JobLoader** — already shadows `jobs.json` entries with `.instar/jobs/schedule/` entries on same-slug. So immediately after migrate, the scheduler reads from the new path while the old `jobs.json` remains for back-compat. Zero scheduling drift during the transition window.
- **Phase 2 installBuiltinJobs** — already wrote `.instar/jobs/instar/<slug>.md` for every shipped default on every update. Migrate complements this by ALSO writing the per-slug manifest at `.instar/jobs/schedule/<slug>.json` based on the operator's pre-migration `jobs.json` (preserves cron/enabled state from the operator's setup).
- **Phase 1c-runtime** — the per-slug body's normalize SHA-256 is what the lock-file verifier uses. Migration uses the SAME normalize function (CRLF→LF, ZWSP/ZWNJ/ZWJ/BOM strip, trimEnd + single newline) via inline code that mirrors `AgentMdLockFile.ts`. The roundtrip is structural.
- **PostUpdateMigrator** — Phase 3 deliberately does NOT auto-run migrate. The spec says Phase 5 ships that.
- **Release-cut gate** — Phase 3 does NOT auto-write `.migration-complete.json`. Phase 4 Dashboard ships the operator confirm button.

### 5. Rollback cost

`--abandon` is the one-button rollback. It removes the new `schedule/` and `instar/` directories, writes `.migration-abandoned.json`, and leaves `jobs.json` intact. The next scheduler boot reads `jobs.json` as before. Tested by `--abandon removes schedule/ and writes the abandonment marker`.

### 6. Seamless Migration Guarantee compliance

This PR fills in the guarantee suite's CLI-path coverage (spec §Seamless Migration Guarantee Rollout interaction). Asserted invariants:

- Invariant 1 (zero job loss) — `non-prompt entries (script/skill) are skipped (legacy path keeps them)` + every prompt entry appears in `outcome.perEntry` with a non-failed action OR an explicit error
- Invariant 2 (zero schedule drift) — `migrates a body-matched default to origin:instar with manifest only` asserts schedule field preserved verbatim
- Invariant 5 (one-button rollback) — `--abandon removes schedule/ and writes the abandonment marker`
- Invariant 9 (fail-closed on any failure) — `refuses to proceed on near-miss when --default-action=fail` writes no partial state
- Backup invariant (rollback anchor) — `writes a pre-migrate backup of jobs.json before any destructive operation`
- Idempotency — `is idempotent — re-running produces stable on-disk state`

The Dashboard-path coverage (invariants 4, 7, 8) lands with Phase 4. The PostUpdateMigrator-path coverage (full guarantee on update) lands with Phase 5.

## Test coverage

`tests/unit/commands/jobMigrate.test.ts` — 11 cases.

All pass locally. Lint + type-check pass.

## What is NOT in this PR

- **PostUpdateMigrator auto-run** — Phase 5.
- **Dashboard "migration available" attention notice** — Phase 4.
- **Dashboard "Confirm migration complete" button** — Phase 4.
- **Release-cut gate enforcement of `.migration-complete.json`** — Phase 4 / Phase 5.
- **Interactive three-choice prompt for near-miss** — would need TTY detection + readline; the `--default-action` flag covers the non-interactive use case. Interactive UX lands with Phase 4 Dashboard.
