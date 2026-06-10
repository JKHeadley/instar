<!-- internal-only -->
# instar-dev: auto-merge on green for every tier

## What Changed

Adds **Phase 7 — Auto-merge on green** to the `instar-dev` skill: once an instar-dev PR's CI is fully
green, the instar-developing agent merges it via the existing `scripts/safe-merge.mjs` wrapper (which
waits for every check, refuses on any red, and confirms the e2e job ran and passed) and narrates the
ship via the Agent Updates channel — it no longer pauses to ask the operator "ready to merge?".
Auto-merge-on-green now applies to **every tier**, not just Tier-1; the Tier-1 wording is corrected so
it no longer reads as a Tier-1-only privilege. No runtime code changes — the merge mechanism and CI
gates it relies on are unchanged. Structure-over-Willpower fix for an operator directive (never pause
to ask for merge; the gates already guarantee mergeability by the time CI is green).

## Evidence

- `skills/instar-dev/SKILL.md` — new Phase 7 + corrected Tier-1 line.
- Mechanism unchanged: `scripts/safe-merge.mjs` already re-imposes all-checks-green (incl. e2e) before
  merging. Tier-1 instar-dev gate passed (ELI16 + side-effects + trace); this PR auto-merges on green
  per the very phase it adds.
