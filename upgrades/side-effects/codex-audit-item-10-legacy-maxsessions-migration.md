# Side-effects review — Codex-instar audit Item 10: canonical maxSessions migration

**Scope:** New `PostUpdateMigrator.migrateLegacyMaxSessions()` step canonicalizes the legacy top-level `maxSessions` config field into `sessions.maxSessions`. On next `instar update`, agents with either or both keys get cleaned up; the canonical key wins when both are present.

Discovered by codey during the 2026-05-22 Codex-instar shortcomings audit (gap #10). The dual-key state was already harmless in code as of audit Item 2 (the spawn manager's live-accessor fallback chain reads canonical first, legacy second) — but the cruft was still misleading to anyone reading the config, and a future code path that only checks the legacy key would silently re-introduce the split-brain.

**Files touched:**
- `src/core/PostUpdateMigrator.ts` — new `migrateLegacyMaxSessions()` method (~70 lines), wired into the `apply()` sequence directly after `migrateConfig()`.
- `tests/unit/PostUpdateMigrator-legacyMaxSessions.test.ts` — new test file, 9 cases covering: promote legacy-only, promote into existing sessions block preserving other fields, remove duplicate matching legacy, remove stale divergent legacy (the echo case), no-op when only canonical, no-op when neither, idempotent on re-run, graceful skip when config.json absent, audit entry written.

**Under-block:** None. The migration only writes when there's a legacy key to remove. Configs with only the canonical key (or neither) are no-ops and skip cleanly.

**Over-block:** Operators who have intentionally diverged the two keys (e.g. legacy=10, canonical=30) will see the legacy key removed and the canonical retained. This matches what the code already reads (audit Item 2's fallback chain reads canonical first), so behavior is unchanged; the migration just makes the file's state match the runtime's state.

**Level-of-abstraction fit:** A dedicated migration method, following the existing `private migrateXxx(result)` pattern. Wired into `apply()` after `migrateConfig` (which handles broader defaults via the ConfigDefaults registry). Separate from migrateConfig because the legacy-key removal isn't expressible as a default — `applyDefaults` only ADDS missing keys, it doesn't delete existing ones.

**Signal vs authority compliance:** `config.sessions.maxSessions` is the canonical SIGNAL; `config.maxSessions` was a legacy SIGNAL. The migration moves authority cleanly to the canonical location. No new authority.

**Interactions:**
- The `getMaxSessions` accessor from audit Item 2 reads `config.sessions?.maxSessions ?? config.maxSessions ?? 5`. After the migration runs, the legacy fallback is dead code on those agents (always falls to canonical). The accessor still keeps the legacy fallback for the brief window before migration runs on an agent.
- `/status` route, HealthChecker, status CLI all already read canonical first — no change.
- The `dashboardPin` migration (also in migrateConfig) is separate and unaffected.

**External surfaces:** None.

**Migration parity:** This IS the migration. New agents created via init don't have the legacy key (init.ts writes canonical). The migration is idempotent — subsequent runs find no legacy key and skip. Per the standard's enforcement that every agent-installed-file change ships with a corresponding migration in PostUpdateMigrator: complete.

**Rollback cost:** Trivial. Remove the call from `apply()` + delete the method + delete the test file. The dual-key state would re-appear over time as no-op-on-future-restarts, but no agent would break.

**Tests:**
- `tests/unit/PostUpdateMigrator-legacyMaxSessions.test.ts`: 9/9 pass.
- `tsc --noEmit`: clean.
- Audit log: every successful run appends a `config-migration-legacy-maxsessions` entry to `.instar/security.jsonl` for operator-visible traceability.
- Empirical confirmation on echo's actual dual-key config will happen on its next `instar update`; the test suite exercises the exact shape (`{ maxSessions: 10, sessions: { maxSessions: 30 } }`) in the "canonical wins" case.

**Decision-point inventory:**
1. **Promote-or-merge for legacy-only configs.** If only the legacy key exists, the migration creates a `sessions` block (if absent) with `maxSessions` set to the legacy value, OR adds `maxSessions` to an existing sessions block while preserving other fields. Tested separately.
2. **Canonical-wins vs. legacy-wins when both exist.** Canonical wins because (a) it's the location the codebase has converged on (HealthChecker, /status route, CLI all read canonical), (b) the legacy was historically the ONLY source so any newer canonical value is presumed more recent. The test "removes legacy when canonical exists with a different value" exercises echo's actual production state (legacy=10, canonical=30) — canonical 30 retained.
3. **Atomic write with audit entry.** Same backup-tmp-rename pattern as the existing `migrateConfig` method. Appends a typed audit entry to `security.jsonl` so operators can trace which agents got migrated and when.
