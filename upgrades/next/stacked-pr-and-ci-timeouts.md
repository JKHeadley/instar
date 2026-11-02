## What Changed

- A pull request aimed at a feature branch (a "stacked" PR) can no longer be merged by the merge tooling: `scripts/safe-merge.mjs` refuses any base other than main (`refused:non-main-base`) before any other step, on every path including `--auto`. A new `stacked-pr-guard` workflow turns such a PR's GitHub badge red with a "retarget to main" instruction, so it no longer shows as clean. The green-PR watcher skips stacked PRs (`non-main-base`) and its stuck-red alarm ignores them. Closes ACT-053.
- Every job in `.github/workflows/ci.yml` now declares `timeout-minutes` (unit 60, integration 50, e2e 70, everything else 15), sized from the slowest of 79 recent runs, so a hung job fails within about an hour instead of GitHub's 6-hour default. Closes ACT-059.

## What to Tell Your User

Nothing changes for you day to day. If you develop Instar itself: a pull request aimed at another pull request's branch now shows a red "retarget to main" check and the merge tooling will not merge it there. Merge the one underneath into main first, then point this one at main.

## Summary of New Capabilities

None. This tightens the existing merge safety checks and adds time limits to CI jobs.

## Evidence

- Before: PR #2142 (base `feat/a2a-inbound-id-ledger`) ran no CI suite yet showed mergeStateStatus CLEAN; PR #2202 was merged branch-to-branch on 2026-10-19. A unit shard on PR 2141 ran 6h00m before failing.
- After: `tests/integration/safe-merge-non-main-base.test.ts` runs the real script with a fake `gh`: a stacked PR is refused on `--auto` and `--admin` with no merge call; a main PR passes the base check. `tests/unit/ci-workflow-timeouts.test.ts` fails if any ci.yml job lacks a timeout.
