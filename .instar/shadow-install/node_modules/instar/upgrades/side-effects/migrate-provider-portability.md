# Side-effects review — Phase 7 migration entry (provider-portability v1.0.0)

**Version / slug:** `migrate-provider-portability`
**Date:** `2026-05-18`
**Author:** Echo
**Second-pass reviewer:** self-review — 5 new tests covering idempotency + Codex detection surfacing; typecheck clean.
**Driving spec:** `specs/provider-portability/README.md` Phase 7 ("Migration design + local agent testing").

## Summary of the change

Adds an idempotent migrator entry to `PostUpdateMigrator` that runs on every `instar update`. The migration is intentionally lightweight: the load-bearing piece (auto-populating `frameworkBinaryPaths` from detection) already happens at every server boot in `Config.ts`, so a one-time on-disk transform isn't required. What this migrator does:

1. Records `provider-portability-v1.0.0-<ISO>` in `_instar_migrations` so re-runs are no-ops and the migration is auditable in `config.json`.
2. Detects Codex CLI presence and surfaces it in the upgrade message ("Codex CLI detected at /path/to/codex — portable to Codex via /route or topicFrameworks config." OR "Codex CLI not detected — install via npm i -g @openai/codex to enable Codex routing.").
3. Does NOT mutate `frameworkBinaryPaths`, `topicFrameworks`, or any other behavior-affecting field — operator choice via `/route` and conversational tooling owns those decisions.

Files touched:
- `src/core/PostUpdateMigrator.ts` — adds `migrateProviderPortability(result)` step and wires it into the `migrate()` orchestration.
- `tests/unit/migrateProviderPortability.test.ts` — 5 tests (missing config, first run, re-run no-op, Codex surfacing, no field mutation).

## Decision-point inventory

- **Migration marker in `_instar_migrations`** — `add`. Matches the existing convention (`defaults-<version>-<ISO>`) so the audit trail is uniform.
- **Skip Codex CLI install detection in migrator (don't auto-install)** — `add` (deliberate non-action). User's package-manager choice.
- **No automatic framework-default flip** — `add` (deliberate non-action). Flipping a Claude-only agent to Codex on update would be a silent behavior change; spec 12 explicitly forbids this kind of silent migration. Operator opts in via `/route` or `topicFrameworks` config.
- **Best-effort Codex detection, fall through on error** — `add`. If `detectCodexPath` throws or returns null, the migrator still records the marker so re-runs don't repeat. The user just gets the "not detected" message.

## Signal vs authority

- The migrator is **signal-only** at the operator level — it records what's true, surfaces the detection result, lets the operator decide.
- The runtime authority is `Config.ts`'s `frameworkBinaryPaths` population at boot, plus the per-topic `topicFrameworks` map + `/route` slash command.

## Over-block / under-block analysis

**Over-block:** None. Existing Claude-only agents update transparently — no new field is added that changes behavior.

**Under-block:** Operators who never run `/route` and never edit `topicFrameworks` stay on claude-code forever even after upgrading. That's the correct default — no silent flip.

## Level-of-abstraction fit

- Lives next to other migration entries in `PostUpdateMigrator` (`migrateConfig`, `migrateContextDeathAntiPattern`, etc.) with the same shape.
- Uses the same `result.upgraded`/`result.skipped`/`result.errors` channels.

## Interactions

- **`Config.ts` runtime detection** — orthogonal. Migrator records a marker; Config.ts populates the runtime field. Both can change independently.
- **`getMigrationDefaults` defaults applier** — orthogonal. That applies safe defaults; this records a versioned marker.
- **Spec 12 Rule 1 validator** — orthogonal. Validator fires at adapter init regardless of migration state.

## Rollback cost

Pure code change. Reverting removes the migrator step from `migrate()` and the entry function. The migration marker stays in `_instar_migrations` of any agent that already ran the update — harmless on re-runs of the reverted code (the marker just isn't checked anymore).

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/unit/migrateProviderPortability.test.ts` — 5/5 green.
- Manual: will run against ai-guy and sagemind config copies as part of Track D step 19 (live verification).
