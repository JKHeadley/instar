# Side-Effects Review — instar-dev: auto-merge on green (every tier)

**Version / slug:** `instar-dev-automerge-on-green`
**Date:** `2026-06-09`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required (Tier 1 — documentation/process change to the dev skill; the merge mechanism it mandates (safe-merge.mjs + CI) is unchanged and already gated)`

## Summary of the change

Adds **Phase 7 — Auto-merge on green (every tier)** to `skills/instar-dev/SKILL.md`, and corrects the
Tier-1 description so auto-merge no longer reads as a Tier-1-only privilege. The new phase mandates that
once an instar-dev PR's CI is fully green, the agent merges it via the existing
`scripts/safe-merge.mjs <PR> --squash --admin` wrapper and narrates the ship via `/telegram/post-update`
— it does NOT pause to ask the operator "ready to merge?". Documentation/process change only; no runtime
code, no new gate, no new merge mechanism (safe-merge.mjs already exists and re-imposes all-checks-green
before merging, including an explicit e2e-ran-and-passed check). Driven by the operator directive
(2026-06-09, topic 23178): "never pause and ask me to merge; we have enough infra in place to ensure
it's good to merge by the time it gets there. Lets fix this via infrastructure."

## Decision-point inventory

- No decision point added/changed. This is a process-doc change to the instar-dev skill. The actual
  merge safety lives in `safe-merge.mjs` (waits for all checks, refuses on any red, confirms e2e) + CI
  branch protection — both unchanged.

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface — under-block not applicable. (The only behavior changed is removing a human
pause AFTER green CI; the green verdict itself — the actual quality gate — is unchanged. `safe-merge.mjs`
still refuses to merge anything not fully green.)

## 3. Level-of-abstraction fit

Correct layer. The fix Justin asked for is behavioral: stop pausing to ask for merge. The instar-dev
skill is exactly where the dev-agent's process is defined, so adding Phase 7 there is the
right-altitude structural fix (Structure > Willpower — the behavior is now baked into the governing
process doc, not left to the agent "remembering" not to pause). The merge mechanism it points at
(`safe-merge.mjs`) already existed; this just makes invoking it the mandated final step for every tier.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface (documentation/process change).

## 5. Interactions

- **Shadowing / double-fire:** none. `safe-merge.mjs` is idempotent-safe (it no-ops / refuses if the PR
  isn't green or is already merged).
- **Races:** none introduced.
- **Existing Tier-1 auto-merge wording:** the prior line implied auto-merge was a Tier-1 privilege;
  Phase 7 generalizes it and the Tier-1 line is corrected to point at Phase 7, so the two no longer
  conflict.

## 6. External surfaces

- **Merge behavior:** the agent now auto-merges green instar-dev PRs instead of asking. This is the
  intended change. It is bounded by CI + `safe-merge.mjs` (refuses on any red, confirms e2e ran+passed),
  so an unsafe PR cannot be auto-merged. Ship narration moves to the Agent Updates channel
  (`/telegram/post-update`) rather than a "ready to merge?" question in the working topic.
- **Migration Parity:** this updates the **instar-dev DEV skill** — used only by the instar-developing
  agent (Echo / a dev-assigned agent), not an end-user feature skill. Per the known skill-install gap
  (the root `skills/` dir, including `instar-dev`, is not synced by `installBuiltinSkills()` and has no
  PostUpdateMigrator path — a separately-tracked issue), the canonical source change here reaches the
  repo; the installed-copy sync for dev agents rides that pre-existing gap. The authoring agent updates
  its own installed `.claude/skills/instar-dev/SKILL.md` directly so the behavior is live immediately.
  A general fix to dev-skill sync is out of scope (it is the standing skill-install-gap project).
- **No config / CLAUDE.md template / hook / route change.** No persisted state.

## 7. Rollback cost

Pure documentation revert — revert the PR; the skill returns to the Tier-1-only auto-merge wording. No
data migration, no runtime impact, no agent-state repair.

## Conclusion

A focused Structure-over-Willpower fix for the operator's directive: auto-merge-on-green becomes the
mandated final phase for every instar-dev tier, removing the redundant "ask to merge" pause while
leaving the actual merge-safety mechanism (`safe-merge.mjs` + CI) untouched. Tier 1 (doc/process change
to the dev skill); second-pass not required. It will be auto-merged on green per the very phase it adds.

## Second-pass review (if required)

**Reviewer:** not required — Tier-1 documentation/process change to the dev skill; no block/allow,
session-lifecycle, sentinel/guard/gate, or recovery-path code is modified. The merge mechanism
(`safe-merge.mjs`) and CI gates it relies on are unchanged.
