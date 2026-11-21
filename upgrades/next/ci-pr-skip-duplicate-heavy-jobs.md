# Pull requests skip the GitHub test jobs that Local Verify already runs

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

In `.github/workflows/ci.yml`, the unit shard matrix, the integration and e2e jobs and the two desktop packaging jobs now carry `if: github.event_name != 'pull_request' && github.event_name != 'pull_request_review'`; the contract and build jobs follow through `needs: unit`. These jobs still run on every push to main and on workflow_dispatch. Pull requests keep Type Check, Repo Invariants, Docs Coverage, Cartographer Freshness and Standards Enforcement Coverage.

Why: Local Verify runs the full suite on the agent's own machines for every pull request and is the only required status check on main. GitHub ran the same suite again, about twenty jobs per push, against an account that runs about four jobs at once, so the publish workflow waited hours for a runner (two hours for its first machine on 2026-11-21). Approved by the Chief of Staff under the owner's release-throughput priority.

## Evidence

- All 365 tests in the twelve unit test files that read `ci.yml` pass with the change.
- The edited workflow parses as valid YAML.
- Main ruleset read live: required status checks are `instar/local-verify` only, so no required check is skipped.
- Rollback is a revert of the single commit.
