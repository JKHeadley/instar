# Side-Effects Review — the sign-in skill gains the cross-machine procedure

**Version / slug:** `signin-skill-cross-machine`
**Date:** 2026-09-27
**Author:** Echo

## Summary of the change

This is a content change to `SUBSCRIPTION_SIGNIN_SKILL_CONTENT`: a new subsection, "A machine with no usable browser (sign it in from a Mac)", placed before the repair table, and three new table rows. It also adds `PostUpdateMigrator.migrateSubscriptionSigninCrossMachine` to deliver both to existing agents. No runtime code path in the repair, enroll or submit-code routes changes.

## Decision-point inventory

- Migration insert-vs-skip: `invariant`. The section goes in when its heading is absent and the stock table heading is present. The rows go in when the first new row is absent and the stock "Anything else" row is present. Anything else is left untouched. It is deterministic, and nothing competes with it.
- The procedure itself is agent judgment within the skill's existing hard lines: expected account only, standard permission list only, no CAPTCHA or phone work-around, and secrets from the vault. None of them is loosened.

## 1. Over-block

None. It adds guidance and makes a file update.

## 2. Under-block

The procedure is prose an agent follows, so its hard lines hold only as far as the agent reads the skill — the same trust level as the existing by-hand section. The procedure keeps the email and permission checks explicit, and the code is piped rather than printed.

## 3. Level-of-abstraction fit

The procedure belongs in the skill; this is the skills-over-scripts standard. Automating it as a self-repair on a browserless machine is a product change that needs its own spec, which is drafted. <!-- tracked: CMT-609 -->

## 4. Signal vs authority compliance

No new authority. The migration makes a deterministic file update, and the skill guides judgment.

## 4b. Judgment-point check

No new automated judgment point.

## 5. Interactions

- It runs after `migrateSubscriptionSigninByHand` and `migrateSubscriptionSigninAgentRun`. A stock v1 copy is replaced whole by the by-hand migration, so this one then does nothing (tested: v1 ends exactly equal to current content).
- The existing agent-run test's reconstruction of the previous version still holds, because the new subsection sits between the agent-run subsection and the table.
- `installBuiltinSkills` stays install-if-missing. The CLAUDE.md awareness bullet for `/subscription-signin` already covers the skill.

## 6. External surfaces

The skill now documents cross-machine calls to a peer's existing `enroll`, `submit-code`, `complete` and `POST /subscription-pool` routes with the mesh Bearer token. All of these routes and their auth already exist; nothing new is exposed.

## 7. Multi-machine posture

This change is about multi-machine operation. Logins stay machine-local by design (`physical-credential-locality`): each machine mints its own login, and nothing is copied. Only the one-time approval code crosses the mesh, over the existing authenticated route. The skill file is installed per agent home by the same migration on every machine.

## 8. Rollback cost

Revert the PR. An agent that already migrated keeps the new text, which is harmless and can be edited back by hand.

## Conclusion

A documentation and procedure update with a conservative, idempotent delivery path. It is safe to ship.

## Class-Closure Declaration (display-only mirror)

`{defectClass: "unbounded-self-action", closure: "n/a", reason: "no self-triggered action added; skill text + one-shot idempotent file migration"}`
