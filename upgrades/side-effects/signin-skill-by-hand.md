# Side-Effects Review — the sign-in skill gains the by-hand procedure

**Version / slug:** `signin-skill-by-hand`
**Date:** 2026-09-25
**Author:** Echo

## Summary of the change

Content change to `SUBSCRIPTION_SIGNIN_SKILL_CONTENT` (new section 3 "Signing in by hand", two table rows, one hard-rule line, revised repair steps and last table row), a Codex device-code recipe, typing-safety rules (verify the frontmost pid and the focused field before every keystroke, after a stray keystroke landed in the operator's chat draft on the Laptop and was deleted unsent), and "pool `active` ≠ signed in"; plus `PostUpdateMigrator.migrateSubscriptionSigninByHand` to deliver it to existing agents. No runtime code path in the repair itself changes.

## Decision-point inventory

- Migration replace-vs-insert-vs-skip — `invariant`: exact hash of the first shipped version → replace whole; heading present → skip; recognizable old table heading → insert section; anything else → leave untouched. Deterministic by design; nothing competes.
- The skill's guidance "sign in by hand when the repair stopped on a page rule" is agent judgment within the skill's written hard lines (expected account only; no CAPTCHA/phone work-around; passwords only on Google's or Claude's own page; secrets from the vault over stdin). Those hard lines are unchanged or tightened.

## 1. Over-block

None. The change only adds guidance and a file update.

## 2. Under-block

The by-hand path is prose followed by an agent, so its hard lines are held by the agent's reading of the skill, not by code. That is the same trust level as the existing skill and the operator's explicit direction (2026-09-25: "use whatever the best tool is for the job … operating more like a human user"). Passwords still only leave the vault over stdin. The permission check on the Authorize page stays the agent's job: the skill tells it to confirm the list is the standard Claude Code set.

## 3. Level-of-abstraction fit

The procedure belongs in the skill, per the skills-over-scripts standard and the operator's direction. Moving the product repair onto this path is a separate change that needs its own spec. <!-- tracked: topic 33890 step 2 -->

## 4. Signal vs authority compliance

No new authority. The migration makes a deterministic file update. The skill guides judgment.

## 4b. Judgment-point check

The by-hand path is judgment within the fixed hard lines listed above. No new automated judgment point is added.

## 5. Interactions

- `installBuiltinSkills` stays install-if-missing. The migration is the update path, per the Migration Parity Standard.
- The CLAUDE.md awareness bullet for `/subscription-signin` already exists and still describes the skill correctly.
- The new import is a separate line, so `iterative-converging-audit-skill-single-source.test.ts`, which pins the iterative-audit import literally, stays green.
- An agent that had edited the skill keeps its edits. The new section goes in before its table, and the old "## 3." heading becomes "## 4.".

## 6. External surfaces

The skill now documents using `screencapture`, `cliclick` and System Events on macOS. These need the Screen Recording and Accessibility permissions where the agent runs. Where a permission is missing, the agent sees a failure and asks the operator. It can't act silently.

## 7. Multi-machine posture

`machine-local-justification: physical-credential-locality`: each machine signs in its own Chrome profile. The skill file is installed per agent home by the same migration on every machine.

## 8. Rollback cost

Revert the PR. An agent that already migrated keeps the new text, which is harmless and can be edited back by hand.

## Conclusion

A documentation and procedure update with a conservative, idempotent delivery path. It is safe to ship.

## Class-Closure Declaration (display-only mirror)

`{defectClass: "unbounded-self-action", closure: "n/a", reason: "no self-triggered action added; skill text + one-shot idempotent file migration"}`
