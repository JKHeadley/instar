<!-- bump: patch -->
<!-- internal-only -->
## What Changed

The `eli16` pull-request check now judges the PR's CURRENT title, description and author type, read live from the GitHub API, instead of the copy frozen in the run's event payload. A re-run of an old run can no longer re-judge an old description and post a stale red (PR #2059, LRN-035). If the live read fails, the check falls back to the payload exactly as before, and the log names the source used (`source=api` or `source=payload`). The workflow gains `pull-requests: read` and passes the PR number and the run's token. EVO-026.

## Evidence

- Unit + end-to-end CLI: `tests/unit/eli16-pr-description-check.test.ts` (a failing payload body with a passing live body passes and logs `source=api`; HTTP error, thrown fetch, malformed response and missing PR number all fall back to the payload; the CLI run against a local API server and against an unreachable one).
