# Pull requests skip the GitHub test jobs that Local Verify already runs

<!-- bump: patch -->

## What Changed

In `.github/workflows/ci.yml`, the unit shard matrix and the integration and e2e jobs now carry `if: github.event_name != 'pull_request' && github.event_name != 'pull_request_review'`; the contract and build jobs follow through `needs: unit`. These jobs still run on every push to main and on workflow_dispatch. Native Windows and Mac packaging remain on pull requests because their compilation, transport and package-content checks are additional coverage; they skip review events only. Pull requests also keep Type Check, Repo Invariants, Docs Coverage, Cartographer Freshness and Standards Enforcement Coverage.

Why: Local Verify runs the full suite on the agent's own machines for every pull request and is the only required status check on main. GitHub ran the same suite again, about twenty jobs per push, against an account that runs about four jobs at once, so the publish workflow waited hours for a runner (two hours for its first machine on 2026-11-21). Approved by the Chief of Staff under the owner's release-throughput priority.

In `scripts/safe-merge.mjs`, `--auto` now honours the selected floor (`resolveFloorSelection`, `autoTakesActionsFloor`): under the `local` floor it takes the local path, so the feedback executor, which always passes `--auto`, keeps merging. The stale gate note in `.github/workflows/publish.yml` is corrected.

In `src/feedback-factory/execute/FeedbackExecutorService.ts`, a safe-merge answer of `verify-pending` (the local floor's "Local Verify has not run for this head yet") is now treated like `deferred:checks-pending`: the reviewed pull request stays open and the merge is retried on the five-minute cadence under the same three-hour deadline, instead of counting as a failed attempt and parking after one retry.

## What to Tell Your User

- **Changes merge sooner**: "GitHub no longer repeats the full test run on every pull request. Our own machines already run it before anything merges, so fewer duplicate jobs compete with releases for a GitHub build machine. We will measure the resulting release times after the change is live. GitHub still runs the full tests on main after each merge."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Pull requests skip GitHub's duplicate heavy test jobs | Nothing to do; Local Verify remains the required check |
| The merge script's `--auto` honours the local floor | Nothing to do; callers that pass `--auto` merge from the Local Verify record |
| A queued Local Verify never parks a fix-factory pull request | Nothing to do; the executor waits and retries |

## Evidence

- The unit test files that read `ci.yml`, `safe-merge-hardening` and the new `tests/unit/safe-merge-auto-local-floor.test.ts` pass with the change; an independent second-pass review concurred after its three concerns were fixed.
- The edited workflow parses as valid YAML.
- Main ruleset read live: required status checks are `instar/local-verify` only, so no required check is skipped.
- Rollback is a revert of the single commit.
