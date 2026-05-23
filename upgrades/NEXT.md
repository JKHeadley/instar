# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

**feat(skill): /verify-claim — 4-tier verification protocol (GSD cherry-pick).**

New user-invocable skill that runs goal-backward verification of a claim that something is built/wired/working. Cherry-picked from the GSD verifier methodology — the spike's highest-leverage finding.

Four levels, run in order, stop at the first failure:
- EXISTENCE — does the artifact exist?
- SUBSTANTIVE — is it real, not a stub?
- WIRED — is it imported AND invoked from the real path? (the level green tests most often skip — a component can compile + pass unit tests yet never be instantiated in the boot path)
- DATA-FLOW — does real data actually flow through it (not 503/empty/hardcoded)?

Reports a status: VERIFIED / HOLLOW / ORPHANED / STUB / MISSING. Use before any "shipped" / "wired in" / "running" / "it works" message — directly addresses the "verify a component is actually wired" lesson (PR #334 shipped sentinels as dead code with a false wired-into-startup claim).

## Evidence

6 unit tests, all green: installs SKILL.md, valid frontmatter, user-invocable, documents all four levels + the full status taxonomy, idempotent (does not overwrite a user-customized copy). TypeScript clean.

Migration parity: adding a new skill needs no migration — installBuiltinSkills() runs on every update and is non-destructive (writes missing SKILL.md only). Verified idempotency in the test.

Side-effects review: `upgrades/side-effects/verify-claim-skill.md`.

## What to Tell Your User

You have a new /verify-claim skill. When you want to be sure something is actually done — not just compiles, not just passes unit tests, but actually wired into the running system and carrying real data — invoke /verify-claim. It runs a four-step check and tells you plainly whether the thing is VERIFIED or only half-done.

## Summary of New Capabilities

One new user-invocable skill. The 4-tier protocol becomes a callable primitive any agent can run before claiming completion, and /build Phase 3 VERIFY can invoke it per must-have. Framework-agnostic (pure prompt skill, no code).
