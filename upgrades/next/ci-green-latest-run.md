<!-- bump: patch -->

## What Changed

**A project item could never be recorded as merged if its pull request's CI had ever been red — even
after it was fixed.**

`StageTransitionValidator.ciIsGreen` evaluated EVERY entry in GitHub's `statusCheckRollup`. GitHub
returns every run of every check, **including superseded ones**, so a check that failed and was
re-run to green appears twice and the failure never disappears. Verified on the live PR #1641
(merged legitimately): 31 rollup entries, four check names duplicated, including
`eli16 FAILURE 01:44:01Z` beside `eli16 SUCCESS 01:45:32Z`. Branch protection merged the PR because it
uses each check's CURRENT state; the tracker refused it with `CI_NOT_GREEN` because it also counted
the stale run.

The rollup is now collapsed to the **latest run per check name** (by `completedAt`, falling back to
`startedAt`) before greenness is judged — which is what GitHub's own merge gate does.

Three safeguards so the dedupe can never hide a genuine failure: the latest run is authoritative in
BOTH directions (a success followed by a later failure is still not green); runs that cannot be
ordered FAIL CLOSED (equal or missing timestamps ⇒ the failing run wins); and unnamed status entries
are keyed individually so a failing one is never collapsed into a passing one.

End-to-end, against the two real merged pull requests with the route's exact helper wiring: both went
from refused to accepted.

## What to Tell Your User

If you track work in projects, marking an item as merged now succeeds for a pull request whose checks
went red and were then fixed — which previously failed with a confusing "CI is not green" long after
the pull request had merged.

## Summary of New Capabilities

- Greenness is evaluated per check against its latest run, matching branch-protection semantics.

## Evidence

- `tests/unit/StageTransitionValidator.test.ts` — five new cases: the live superseded-failure shape;
  the reverse direction (later failure still refuses); unorderable runs fail closed across three
  variants; unnamed entries never collapsed; an in-flight latest run still not green.
