# Convergence Report — Parity renderings backfill

## ELI10 Overview

Three recent PRs shipped canonical sources for skills, hooks, and memory entries but deferred the migration entry that would render those canonical sources into framework-native shape for existing deployed agents on update. The PostUpdateMigrator now iterates every registered parity rule and re-renders every canonical instance into the right framework-native location on every update. Idempotent via the migrations marker; per-rule policies preserved (hooks always-overwrite per §4, skills and memory refuse-on-conflict per §5).

## Original vs Converged

The audit identified the gap. The fix is a registry-iteration backfill — one new PostUpdateMigrator method that walks `listParityRules()` and remediates every instance × framework combination. The complement is a new `migrateAsync()` wrapper so the existing sync `migrate()` keeps its contract while async work has a path. Three production callers (cli, UpdateChecker, server) are in async contexts already and switch to `await migrateAsync()` cleanly.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | Manual lessons-check (against canonical principles index) | 0 contradictions; 0 deferrals | None |

## Manual lessons-aware findings

See `lessons-engaged:` frontmatter and the manual lessons-check table in the spec body. Engaged P1 (in-code backfill, not docs request), P3 (the §5 direct fix), P4 (11 unit tests covering registry iteration, framework filtering, error categorization, idempotency, marker recording, empty-canonical, continue-past-failure, migrateAsync contract), P10 (full backfill in v0.1 covering all currently-registered rules; future Agent/Tool rules pick up automatically via the registry-iteration pattern). No contradictions.

## Convergence verdict

Converged at iteration 1. Tactical amendment closing the §5 backfill gap. The registry-iteration pattern is the durable solution for any future primitive's rendering needs.

## Deviation note

Tactical amendment under autonomous-mode hybrid-C pre-authorization. Manual lessons-check applied transparently in the spec body. The lessons-aware reviewer (PR #260) is structurally in /spec-converge SKILL.md but its content migration to deployed agents has not yet been built — this PR's backfill is the mechanism that will eventually render the updated SKILL.md content for deployed agents. So this PR is the bootstrap for /spec-converge's own update propagation. Future specs in this autonomous session will pick up the lessons-aware reviewer via the same pattern.
