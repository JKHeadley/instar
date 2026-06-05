<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Added a CI gate (`.github/workflows/eli16-pr-gate.yml` + the pure check
`scripts/eli16-pr-description-check.mjs`) that requires every PR's DESCRIPTION to carry a
plain-English ELI16 overview, and FAILS the PR when it is missing. Per Justin's standard
(2026-06-05): the PR description is what a reviewer reads and approves on the link, and the PRs "had
different formats." The ELI16 *file* (docs/specs/<slug>.eli16.md) is unchanged and still enforced at
commit time; this closes the PR-body half. Re-runs on `edited` (self-clears on a description fix);
exempts bot authors + the automated release-cut PR.

## Evidence

- The decision is a PURE function (`checkPrDescriptionEli16`) with 10 unit tests covering both
  sides (has-overview → pass; missing / too-short / next-heading-boundary / comment-stripped → fail)
  and every exemption (bot, release-cut, title-mentions-release non-exemption, null inputs).
- `node --check scripts/eli16-pr-description-check.mjs` clean. New additive workflow — cannot affect
  existing checks/builds/releases; a failing PR is visible + self-clears on a description edit.
- This PR's own description carries an ELI16 overview (dogfoods the gate). scripts + workflow + test
  only, no `src/` (internal-only lane).
