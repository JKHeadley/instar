## What Changed
- **Local Verify reads open pull requests 25 at a time.** The status reconciler's open-PR read (`src/localVerify/reconcilerSeams.ts`) used one `gh pr list --limit 1000` call with every PR's checks. gh pages that 100 at a time, and past ~100 open PRs a page outran GitHub's GraphQL time budget, so every read returned HTTP 502. From 2026-11-13 03:50 UTC (102 open PRs) the queue admitted nothing new. The read is now a paged `gh api graphql` query of 25 PRs a page (~7 s for 97 PRs). Its output is identical to before: same fields, bot authors as `app/<login>`, and an unfinished check's conclusion as `''`. A bad or failed page is still a failed read, never a short list.

## What to Tell Your User
Nothing changes for most agents: this only affects the pre-merge test queue that the instar maintainer runs. Once more than about 100 pull requests were open, that queue stopped taking new ones. It now reads them in smaller batches and works again.

## Summary of New Capabilities
- None. A fix: the Local Verify open-PR read is paged (25 PRs a page), so it keeps working with more than 100 open PRs.

## Evidence
- `tests/unit/localVerify/reconcilerSeams-listOpenPrs.test.ts` (7 tests): paging, output parity, bot authors, truncation, failure cases, the empty list.
- Live: 97 open PRs in 4 pages, ~7 s. Field-by-field comparison with `gh pr list --limit 30`: 30 PRs, 0 differences.
