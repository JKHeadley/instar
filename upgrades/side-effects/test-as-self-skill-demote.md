# Side-Effects Review — test-as-self SKILL Part 2.1 demote + migrator (Track F follow-up)

**Scope.** `.claude/skills/test-as-self/SKILL.md` (lead with the one-button
command, demote the manual recipe to fallback), `src/core/PostUpdateMigrator.ts`
(`migrateTestAsSelfSkill` + registration), `tests/unit/migrate-test-as-self-skill.test.ts`.

**What + why.** Track F shipped the `instar test-as-self` command but left the
SKILL.md as the v1 manual runbook (deferred, tracked). This closes that loop:
the SKILL now leads with "## The one-button path (Part 2.1 — use this first)"
(the command), with the manual recipe demoted to fallback — so an agent reading
the skill reaches for the command first. Plus a PostUpdateMigrator method so
EXISTING agents' on-disk SKILL.md gets the update (installBuiltinSkills is
install-if-missing, so a dedicated migration is the only path per the Migration
Parity Standard).

**Side-effects review.**
- **Content-only skill change** — no behavior change; the command itself shipped
  in Track F (#472). This just makes it discoverable in the skill surface.
- **Migration is conservative + idempotent** — re-copies the bundled SKILL only
  when the installed copy LACKS the Part 2.1 marker AND still matches the stock
  fingerprint (`Throwaway-Deploy Harness` + `verify.mjs`). A customized skill is
  left untouched (recorded in result.skipped); an already-updated one is a no-op;
  a not-installed one is a no-op. Mirrors the proven migrateBuildSkillMethodology
  pattern exactly.
- **No data/secret impact** — pure doc/skill content.

**Test coverage.** Unit `tests/unit/migrate-test-as-self-skill.test.ts` (4):
stock-v1 → updated (marker present, result.upgraded set); idempotent (already-
marked → unchanged, no upgrade); customized → untouched (result.skipped);
not-installed → no-op (no error). All green; tsc clean. The test also implicitly
verifies the bundled SKILL.md carries the new marker.

**Migration parity.** This IS the migration-parity fix for Track F's SKILL
update. New agents get the new SKILL via installBuiltinSkills; existing agents
get it via `migrateTestAsSelfSkill` on update.

**Rollback.** Revert. The SKILL reverts to the v1 manual-first runbook; the
command still works (it's independent). No data change.
