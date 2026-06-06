<!-- bump: patch -->

## What Changed

Fixes #866: `POST /projects/:id/advance` building→merged always failed
`GH_PR_VIEW_UNAVAILABLE` because `StageTransitionValidator` has no internal
default for `ghPrView`/`gitMergeBaseIsAncestor` and the route never injected
them — so no project item could ever reach `merged` through the live API.
The route now injects both as read-only helpers (`gh pr view` and
`merge-base --is-ancestor` via SafeGitExecutor.readSync) against the
project's target repo. A wiring-integrity test asserts the helper-absent
error can never recur.

## What to Tell Your User

If you drive a multi-spec initiative through the projects pipeline, its
items can now actually reach the "merged" stage — the system verifies the
work's pull request really merged (merge state, commit reachable on the
main branch, CI green) instead of always erroring out. Project status
finally tracks reality through the whole pipeline.

## Summary of New Capabilities

- `POST /projects/:id/advance` with `targetStage: "merged"` now works end to
  end (was structurally impossible): it verifies the PR via `gh pr view` and
  confirms the merge commit is reachable on `origin/main` before recording
  the item as merged.

## Evidence

- tests/integration/projects-api.test.ts: building→merged now returns
  GH_PR_VIEW_FAILED (not UNAVAILABLE), deterministic regardless of whether
  gh is installed/authed. Full projects-api (45) + StageTransitionValidator
  (26) green; tsc + destructive lint clean.
