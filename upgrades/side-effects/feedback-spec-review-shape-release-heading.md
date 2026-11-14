# Feedback spec review release-heading correction: side effects

## Summary

Tier 1 documentation correction. The release fragment for the feedback spec-review shape fix now uses the repository's exact `## What Changed` heading. This makes the pending release assembler and the pre-push evidence gate recognize the explanation. No runtime code, reviewer policy, or migration behavior changes in this follow-up.

## Reviewed effects

- The fragment describes the current-head shape check and its design-versus-fix test standard. It does not claim that PR #2439 has been approved, reopened, or merged.
- The existing `feedback-spec-review-shape.md` side-effects review covers the behavior change. This companion review covers the later release-note correction and its discoverability effect without replacing that review.
- A malformed or expanded design PR remains refused by code; a valid one-file spec draft still needs independent review. The release text does not grant approval or relax the merge gate.
- Rollback of the heading correction would make the release note fail the canonical heading check again; no persisted state or user data is affected.

## Evidence

`node scripts/check-repo-invariants.mjs` passed after the canonical heading correction. `tests/unit/feature-delivery-completeness.test.ts` and `tests/unit/builtin-manifest.test.ts` passed 234/234. The complete exact-head `npm test` passed 2,897 files and 53,047 tests, with nine expected skips and zero failures before this documentation-only companion was added. CI and full aggregate verification remain pending.
