---
slug: pre-push-upgrade-guide-validation
review-convergence: converged
approved: true
approved-by: justin
iterations: 1
---

# Pre-Push Upgrade-Guide Validation — Stop Silent Publish Failures

## Problem

The Publish to npm workflow has been silently failing for 2+ days on every push to main (2026-05-13 through 2026-05-15). Cause: `upgrades/NEXT.md` accumulated content that fails the publish-time validator in `scripts/check-upgrade-guide.js`:

- Inline-code backticks inside `## What to Tell Your User` (e.g. `` `intelligenceProvider: "anthropic-api"` ``)
- camelCase config-key references inside `## What to Tell Your User` (e.g. `preCompactionFlush.enabled: true`)
- Fix-claiming `## What Changed` without a `## Evidence` section

The pre-push gate at `scripts/pre-push-gate.js` did NOT run the same validation. So malformed NEXT.md files passed `git push`, merged on main, and only failed at publish-time — where the failure is logged as an annotation on a workflow run that no one watches. Consequence: yesterday's token-ledger Phase 1 (#112), this morning's PromptGate token-burn fix (#226), and the entire remediation track were stranded on main for hours-to-days each with no agent picking them up.

The root issue is asymmetric enforcement. Two gates (pre-push + publish-time) check overlapping but non-identical rules, so violations slip through the looser gate and break at the tighter one.

## Root Cause

`scripts/pre-push-gate.js` had its own minimal validator inlined: it checked section presence and min-length but not the WTTYU technical-leakage checks (inline code / camelCase / fenced code) and not the "fix claim → Evidence required" rule. `scripts/upgrade-guide-validator.mjs` already contained the canonical validator. Pre-push wasn't consuming it.

## Fix

Pre-push-gate.js now imports `validateGuideContent` from `./upgrade-guide-validator.mjs` and runs it on whichever guide is active (NEXT.md if present, otherwise the versioned `${version}.md`). All validator-reported issues become errors at push time. Same logic as `check-upgrade-guide.js` runs at publish time — so a malformed guide that would block publish now also blocks push, with the same error message.

The local section-presence + template-placeholder checks in pre-push-gate.js are removed in favor of the validator's canonical versions, keeping a single source of truth.

## Acceptance Criteria

1. `scripts/pre-push-gate.js` imports `validateGuideContent` from `./upgrade-guide-validator.mjs`.
2. The gate runs `validateGuideContent` on NEXT.md (or versioned guide fallback) and surfaces all returned issues as errors.
3. Integration test in `tests/unit/pre-push-gate.test.ts` confirms the gate rejects each of the three publish-blocker shapes:
   - Inline-code backticks in WTTYU → exit non-zero with "contains inline code" in stdout
   - camelCase config key in WTTYU → exit non-zero with "camelCase config key reference"
   - Fix-claim with no Evidence section → exit non-zero with `has no "## Evidence" section`
4. A well-formed NEXT.md (with a recent side-effects artifact) passes the gate cleanly (exit 0).
5. The existing `pre-push-gate.test.ts` content-pattern tests still pass (only the now-obsolete "[Feature name]" reference is replaced with a check that the validator is imported).

All five criteria are pinned by the new integration tests (`tests/unit/pre-push-gate.test.ts`, 4 new + adjusted scaffolding = 10 tests total).

## Decision Points (signal vs authority)

The upgrade-guide validator is an existing deterministic authority over release-notes well-formedness. This PR doesn't introduce a new decision point — it makes the pre-push gate consume the same authority that the publish workflow already consults. Compliant with `docs/signal-vs-authority.md`: no brittle gate gains new blocking power; an existing authority's decisions are surfaced earlier in the workflow.

## Rollback

Revert `scripts/pre-push-gate.js` and the test additions, ship a patch release. No persistent state, no migration. The fall-back behavior is the pre-fix state (publish-time validation only) — strictly equal-or-worse, not "broken". Rollback cost: ~5 minutes.

## Side-Effects Review

`upgrades/side-effects/pre-push-upgrade-guide-validation.md` — covers the seven gate questions plus reviewer concurrence.

## Convergence Notes

Single-iteration. The motivating incident is documented in PR #228 (which manually unblocked the same publish failure today). Justin's authorization on Telegram topic 8615 explicitly covered "the publish pipe failing silently for two days is the deeper issue here. The cleanest fix would be to move the upgrade-guide validation INTO the pre-push gate." This PR implements that exact ask.
