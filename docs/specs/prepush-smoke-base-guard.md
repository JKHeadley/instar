---
title: Pre-push smoke base resolver and breadth guard
review-convergence: retrospective-single-pass
approved: true
eli16-overview: prepush-smoke-base-guard.eli16.md
---

# Pre-push Smoke Base Resolver and Breadth Guard

## Problem

The pre-push hook currently asks Vitest for changed tests relative to a hard-coded remote base. In agent worktrees, that base can be stale or unrelated to the branch being pushed. When the base is wrong, `vitest --changed` can select a broad test set and turn a local smoke check into a long-running gate.

That behavior is especially harmful because local smoke is supposed to provide fast feedback. It must not compete with PR CI as the merge authority.

## Scope

This change updates the pre-push smoke path only:

- Resolve the smoke base from the branch's configured upstream or push remote first.
- Fall back through `JKHeadley/main`, `upstream/main`, and `origin/main`.
- Log the chosen base and changed-file count before invoking Vitest.
- Count the selected Vitest affected set before running it.
- Skip local smoke when the changed-file or selected-test set is too broad, with a clear message that CI remains the authority.

The failed-files-only retry behavior is intentionally not included in this PR's accepted scope.

## Non-Goals

- Do not change CI behavior.
- Do not change the Vitest push config itself.
- Do not add failed-files-only retry semantics in this PR.
- Do not make local smoke mandatory for broad changes.

## Acceptance Criteria

- The smoke runner prefers branch upstream or push remote before canonical fallback remotes.
- The hook logs the selected base and changed-file count before Vitest list/run commands.
- The runner skips local smoke when the selected set exceeds configured caps.
- The skip message states that local smoke is too broad and CI is the authority.
- Unit tests cover resolver ordering and breadth-guard behavior.
- The instar-dev precommit gate passes before publishing.
