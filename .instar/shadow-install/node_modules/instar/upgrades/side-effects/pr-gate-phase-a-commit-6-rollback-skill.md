# Side-Effects Review — rollback-from-artifact built-in skill

**Version / slug:** `pr-gate-phase-a-commit-6-rollback-skill`
**Date:** `2026-04-17`
**Author:** `Echo (instar-developing agent)`
**Second-pass reviewer:** `not required — skill registration, inert at rest, no runtime surface until explicitly invoked`

## Summary of the change

Adds a `rollback-from-artifact` entry to `installBuiltinSkills`' skills Record in `src/commands/init.ts`. On every fresh agent init and every `npm update` that runs `migrateBuiltinSkills`, agents gain `.claude/skills/rollback-from-artifact/SKILL.md` — a not-user-invocable skill that documents how to execute the §7 "Rollback cost" section of a side-effects artifact.

The skill is *documentation with a clear procedure*, not a runtime action. It only fires under explicit incident-response context: a pr-gate regression, a release that needs reverting, or an Echo-detected `rollback-requested` Attention Queue entry. It refuses to run without Justin's authorization and never force-pushes.

Files touched:
- `src/commands/init.ts` — new entry in the skills Record in `installBuiltinSkills`.
- `tests/unit/init-rollbackFromArtifactSkill.test.ts` — 5 tests covering install-on-fresh, frontmatter structure, user-invocable=false, required section presence, and idempotency (no overwrite of a customized copy).

This is commit 6 in the Phase A landing of `docs/specs/PR-REVIEW-HARDENING-SPEC.md`. Spec line 427 calls for this skill.

## Decision-point inventory

- **None.** The skill is a markdown document inside a skills directory. It has no runtime invocation surface; no hook, job, or prompt auto-triggers it. When invoked (by Justin, by an explicit operator action, or by incident-response tooling that this commit does NOT ship), the skill's hard rules list three refusals — these are *within-skill* constraints, not decision points on the host system.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. The skill is a template file installed on disk. It doesn't reject anything until the day it's invoked, and the rejection semantics inside the skill (missing artifact, missing §7, unclean revert, unauthorized trigger) are refusals to proceed with a rollback — a deliberate halt, not a block of user intent.

---

## 2. Under-block

**What failure modes does this still miss?**

No block/allow surface — under-block not applicable. The skill ships with three hard rules (no force-push, no extrapolation of missing §7, no revert of artifact-less commits). A rollback that needs to violate any of those should be handled by Justin directly, not by this skill.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. `installBuiltinSkills` is the existing single-responsibility place for shipping new skills to every agent. Adding a new entry to its Record follows the established pattern (the existing 14 skills). The skill itself is documentation — the runtime effect of a rollback is handled by git + PR infrastructure, which is the correct layer for that.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface. A markdown skill template ships to disk; no runtime decision is made by installing it.

The skill's content itself reinforces signal-vs-authority (see skill's `Related` section). Rollback decisions are human-authorized actions on documented artifacts, never automated from signals.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** the skill directory ships alongside 14 existing skills. No name collision (`rollback-from-artifact` is new). No shadow.
- **Double-fire:** `installBuiltinSkills` uses `fs.existsSync` to skip if `SKILL.md` is already present. Re-running is a no-op. Verified by the idempotency test.
- **Races:** `fs.writeFileSync` is atomic at the POSIX level.
- **Feedback loops:** none.
- **Interaction with `/build`, `/instar-dev`:** `/instar-dev` PRODUCES side-effects artifacts whose §7 this skill CONSUMES. No coupling at install time; the relationship is documentary.
- **Interaction with `.husky/pre-push` and `scripts/pre-push-gate.js`:** the push-gate validates that artifacts exist for release commits. A rollback commit produced via this skill also produces its own side-effects artifact (`revert-<slug>.md`) that satisfies the gate. Out of scope for this commit.
- **Interaction with Attention Queue:** the skill's "When this fires" section names `rollback-requested` as one trigger. No code in this commit wires that trigger. A future commit (or operator action) can file such an entry; the skill exists as the documented response.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** none.
- **Users of the install base:** on next `npm update`, the `/rollback-from-artifact` slash-command becomes listable in `.claude/skills/`. It does not auto-execute or self-invoke. Subsequent updates: idempotent no-op unless the user edited the file (in which case the edit is preserved).
- **External systems:** none.
- **Persistent state:** one new SKILL.md file per agent, ~5KB.
- **Timing:** O(1) file write at install time. Runtime: zero until invoked.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code revert. Remove the entry from the skills Record and delete the test file. Already-migrated agents retain `.claude/skills/rollback-from-artifact/SKILL.md` on disk — harmless, since nothing auto-invokes it. Users who want a clean revert can `rm -rf .claude/skills/rollback-from-artifact/`; the reverted `installBuiltinSkills` will not re-create it.

Estimated rollback effort: one commit revert, one patch release. Zero operational complexity.

---

## Conclusion

A documentation-only skill addition with clean idempotent install semantics. Runtime-inert until explicitly invoked; invocation rules enforce Justin-authorized rollback on documented artifacts, matching the signal-vs-authority principle. 5 new tests pass; no adjacent test surface affected. tsc clean.

Clear to ship as Phase A commit 6 of 8.

---

## Second-pass review (if required)

Not required.

---

## Evidence pointers

- Source: `src/commands/init.ts` — new entry in `installBuiltinSkills` skills Record, immediately after `git-sync`.
- Tests: `tests/unit/init-rollbackFromArtifactSkill.test.ts` — 5 tests, 197ms.
- Type check: `npx tsc --noEmit` — clean.
