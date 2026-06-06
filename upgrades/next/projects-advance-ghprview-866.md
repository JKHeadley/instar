<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Fixes #866: `POST /projects/:id/advance` building→merged always failed
`GH_PR_VIEW_UNAVAILABLE` because `StageTransitionValidator` has no internal
default for `ghPrView`/`gitMergeBaseIsAncestor` and the route never injected
them — so no project item could ever reach `merged` through the live API.
The route now injects both as read-only helpers (`gh pr view`,
`git merge-base --is-ancestor`) against the project's target repo. A
wiring-integrity test asserts the helper-absent error can never recur.

## Evidence

- tests/integration/projects-api.test.ts: building→merged now returns
  GH_PR_VIEW_FAILED (not UNAVAILABLE), deterministic regardless of whether
  gh is installed/authed. Full projects-api (45) + StageTransitionValidator
  (26) green; tsc clean.
