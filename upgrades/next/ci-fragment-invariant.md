<!-- bump: patch -->

# CI-side release-fragment validation (publish-jam guard)

## What to Tell Your User

Nothing user-visible. A release-pipeline failure mode is closed: a malformed release-note fragment can no longer sit silently on the main branch and jam every subsequent release — it now turns CI red immediately on the PR that carries it (or on main itself, loudly attributable).

## Summary of New Capabilities

- The Repo Invariants required CI check now assembles and validates all release-note fragments (`upgrades/next/*.md` + legacy `NEXT.md`) using the same shared validators the publish workflow uses.
- Admin/web merges can no longer bypass fragment validation (the pre-push hook was local-only).

## What Changed

`scripts/check-repo-invariants.mjs` gains invariant #3 (assemble + validate fragments in-memory; throws and validator issues are failures; zero fragments passes). Reuses `assembleNextMd` + `validateGuideContent` — no duplicated rules, no drift. Tests cover all four boundary states (valid, malformed-assembly, missing-section, empty). Task #42.
