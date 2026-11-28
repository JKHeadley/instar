# Every tracked bug fix receives constitutional assessment

<!-- bump: patch -->
<!-- visibility: internal -->

## What Changed

Small development changes now prepare the same warning-only constitutional advisory as larger
ones. The existing independent reviewers receive the complete pinned governing purpose and rule
book, with source and checker identity. Missing, sensitive, unsupported or oversized inputs remain
explicit unavailable results, never approval. Large feedback fixes retain their complete existing
safety review when constitutional context cannot fit. Bug reports distinguish observations from
unreviewed remedies, and existing agents receive the guidance and helper through migration.

## What to Tell Your User

Small fixes used to be able to skip the check that asks whether a change fits the project's purpose and rules, and a bug report could steer a builder toward a suggested remedy nobody had reviewed. Now every size of development change prepares that advisory, and the existing independent reviewers are given the complete purpose and rule book to judge the actual change themselves. The advisory only warns: it does not block a change, it does not add an approval for you to give, and a missing or empty advisory is never treated as approval. Bug reports now describe what was observed first and treat any proposed remedy as a guess to be tested.

## Summary of New Capabilities

No new switch or command. Development changes of every tier carry a warning-only constitutional advisory, reviewers receive the full governing documents, and the feedback skills ask for the observed problem before any remedy. Existing agents receive the updated guidance and helper on update.

## Evidence

Unit: governing-constitution, constitutional-change-review and PostUpdateMigrator-constitutionalReview.
Integration: constitutional-change-review and constitutional-trace-review. E2E: constitutional-change-review-lifecycle.
Spec: docs/specs/bug-fix-constitutional-review.md.
