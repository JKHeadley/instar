# Side-Effects Review — /subscription-signin built-in skill

**Version / slug:** `subscription-signin-skill`
**Date:** 2026-09-24
**Author:** Echo

## Summary of the change

Adds skill content (markdown) and registers it in `installBuiltinSkills` (write-if-missing). Adds a CLAUDE.md awareness bullet to the template plus an idempotent, content-sniffed `PostUpdateMigrator` patch placed after the one-click-repair bullet migration it anchors on.

## Decision-point inventory

None. Documentation the agent reads; no gate, filter or route.

## 1. Over-block

None — the skill blocks nothing at runtime.

## 2. Under-block

The skill tells the agent to sign a profile back in to Google with the vault password + authenticator code; that uses the existing repair's secret fills (vault by name, never logged). Adding an authenticator to an account is explicitly gated on the person's one-time yes.


A skill is guidance, not enforcement. The enforceable rules it states (normal browser on macOS, origin/identity floors, never driving a window it did not open) are enforced in code by the repair itself; the skill does not replace them.

## 3. Level-of-abstraction fit

Right layer per the operator's skills-over-scripts standard: procedure and judgment live in a skill; the mechanism stays the single built-in repair.

## 4. Signal vs authority compliance

No authority added.

## 4b. Judgment-point check (Judgment Within Floors standard)

N/A — no decision point.

## 5. Interactions

`installBuiltinSkills` never overwrites an existing `subscription-signin/SKILL.md`. The migration only fires when the one-click bullet exists and the new bullet does not; it runs after the migration that adds that anchor, so a fresh update applies both in one pass (tested).

## 6. External surfaces

None beyond agent-visible text.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface.

## 7. Multi-machine posture (Cross-Machine Coherence)

Skill files are per-agent-home, installed on each machine by that machine's update — `unified` in content (every machine gets the same text). The procedure itself tells the agent that profiles and logins are per machine.

## 8. Rollback cost

Revert; an installed SKILL.md is inert text and can be left or deleted.

## Conclusion

Low risk, documentation-shaped change. Ship.

## Evidence pointers

`tests/unit/init-subscriptionSigninSkill.test.ts`, `tests/unit/PostUpdateMigrator-assistedRelogin.test.ts`.

## Class-Closure Declaration (display-only mirror)

`{defectClass: "unbounded-self-action", closure: "n/a", reason: "documentation-only skill; no self-triggered action"}`
