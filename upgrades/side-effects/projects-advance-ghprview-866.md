# Side-Effects Review — projects advance ghPrView wiring (#866)

**Version / slug:** `projects-advance-ghprview-866`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required — small read-only wiring fix + a wiring-integrity test`

## Summary of the change

`POST /projects/:id/advance` building→merged always failed `GH_PR_VIEW_UNAVAILABLE`: `StageTransitionValidator` requires `ctx.ghPrView` (and `ctx.gitMergeBaseIsAncestor`) for that edge but provides NO internal default (unlike `readSpecFrontmatter`, which `loadFrontmatter` defaults), and the route built `validationCtx` without them. Fix: inject both as READ-ONLY helpers (`gh pr view --json state,mergeCommit,statusCheckRollup` and `git merge-base --is-ancestor`) against `project.targetRepoPath`. No item could ever reach `merged` through the live API before this — found closing out multimachine-coherence P0.

## Decision-point inventory
- `building → merged` gate — was UNREACHABLE (always errored before the real check) → now REACHES the real GitHub merge-state check. The gate's logic is unchanged; only its required helpers are now provided.

## 1. Over-block
Before: 100% over-block (every merged transition rejected regardless of truth). After: the gate rejects only when the PR isn't genuinely merged. Strict improvement.

## 2. Under-block
The helper trusts `gh`/`git` output for the project's target repo (operator-controlled). A compromised target repo could misreport — but that repo is the operator's own; no new external trust surface.

## 3. Level-of-abstraction fit
Helpers injected at the route (where targetRepoPath + child-process access live), consumed by the pure validator — the same seam the validator's tests already use with mocks. Right layer.

## 4. Signal vs authority compliance
**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)
- [x] No — the gate is a smart validator (real GitHub state); the change only supplies its inputs. No brittle detector gains authority.

## 5. Interactions
- The helpers are read-only (`gh pr view`, `git merge-base --is-ancestor`) — no mutation, no SafeGitExecutor needed (that funnel is for destructive ops).
- A missing/unauthed `gh` throws inside the helper → validator maps to `GH_PR_VIEW_FAILED` (a clean rejection), never a crash.

## 6. External surfaces
- Spawns `gh`/`git` against the project's target repo when a merged transition is attempted. No new persistent state, no messaging, no fleet surface. Other advance edges (outline→spec, approved→building, →skipped) unchanged.

## 7. Rollback cost
Pure code revert + patch. No state.

## Conclusion
Closes #866: the projects pipeline can record merged steps for the first time. The wiring-integrity test asserts the helper-absent error can never recur. Clear to ship.

## Evidence pointers
- `tests/integration/projects-api.test.ts` — new building→merged test asserts `code !== GH_PR_VIEW_UNAVAILABLE` (→ `GH_PR_VIEW_FAILED`), deterministic regardless of gh presence; full file 45 tests + StageTransitionValidator 26 green; tsc clean.

_Follow-up: the merge-base catch carries an `@silent-fallback-ok` note (non-zero `--is-ancestor` exit = the negative answer, not a degradation) — holds the no-silent-fallbacks budget._
