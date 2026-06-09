## What Changed

fix(autonomous): close the autonomous-skill **setup-race** so concurrent autonomous sessions never collide on a shared state file. The stop-hook already resolves a per-topic state file (`.instar/autonomous/<topicId>.local.md`) and migrates the legacy single file — but the *skill's* setup step still wrote the legacy single file `.instar/autonomous-state.local.md`, so two sessions booting near-simultaneously could race on it in the window before the hook migrates. The skill now writes the per-topic file **directly** at setup, skipping the shared path entirely. The hook's reading logic is unchanged (per-topic preferred, legacy fallback + migrate retained for in-flight older jobs).

## What to Tell Your User

Nothing user-facing. This is an internal robustness fix so multiple autonomous sessions run cleanly side by side without clobbering each other's state.

## Summary of New Capabilities

- `.claude/skills/autonomous/SKILL.md` — setup step writes the per-topic state file `.instar/autonomous/<topicId>.local.md` directly (keyed on `report_topic`); cancel + hook-config sections updated to match.
- `PostUpdateMigrator` — the existing autonomous-SKILL.md migration marker is bumped so existing agents re-deploy the corrected skill on update (idempotent; customized skills left untouched).
- The autonomous stop-hook is **unchanged** (it already reads per-topic + migrates legacy).

## Evidence

- Migration suite + autonomous sweep green: `PostUpdateMigrator-autonomousHookPath` (12), plus `PostUpdateMigrator-autonomousStopHook` / `autonomous-skill-deployment` / `migration-parity` (47 total), and `autonomous-state-location` / `autonomous-multi-session` / `autonomous-stop-hook-topic-keyed` (41). `tsc --noEmit` clean.
- New tests assert: a fix-1 SKILL.md (old marker, no per-topic marker) re-deploys to per-topic; second run is a no-op (idempotent); the bundled SKILL.md instructs writing the per-topic file the hook reads.
