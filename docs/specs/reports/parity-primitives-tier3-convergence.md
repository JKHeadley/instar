# Convergence Report — Parity primitives Tier-3 lifecycle tests

## ELI10 Overview

The Testing Integrity Standard requires three test tiers for every feature; Tier-3 is the end-to-end lifecycle assertion that the feature is actually alive in the production-init path. The recent primitive PRs (#252-#254) shipped Tier-1 unit tests but skipped Tier-3. This PR closes the gap with one consolidated 12-test E2E suite covering registry, each rule end-to-end, the parity-renderings backfill, and the FrameworkParitySentinel boot lifecycle. No mocks. Real fixture project, real rendered files on disk.

## Original vs Converged

The audit identified the Tier-3 gap. The fix is one new test file at `tests/e2e/parity-primitives-lifecycle.test.ts` plus a small migrator categorization tweak (recognize `'refused to remediate'` as a skip alongside `'user-edit-conflict'`). The consolidated suite is structured with describe() blocks per concern so failures localize cleanly while sharing fixture setup.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | Manual lessons-check (against canonical principles index) | 0 contradictions; 0 deferrals | None |

## Manual lessons-aware findings

See `lessons-engaged:` frontmatter and the manual lessons-check table in the spec body. Engaged P1 (Tier-3 is the structural verification), P4 (direct fix for the audit-identified Tier-3 gap, 12 new tests with no mocks), P6 (full unit + e2e suite green), P10 (one consolidated suite vs four siloed stubs). No contradictions.

## Convergence verdict

Converged at iteration 1. Single consolidated E2E suite + small migrator categorization tweak. Registry-iteration pattern in the test file means future Agent and Tool parity rules will be covered automatically without test additions.

## Deviation note

Tactical amendment under autonomous-mode hybrid-C pre-authorization. Manual lessons-check applied transparently in the spec body. This PR's base branch is `fix/parity-renderings-backfill` (PR #262) since the Tier-3 tests assert on the `migrateAsync` API that lands in #262. After #262 merges, this PR's base auto-rebases to main.
