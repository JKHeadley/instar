# The auto-merger reads its open PRs in small GraphQL pages

<!-- bump: patch -->

## What Changed

`GreenPrAutoMerger`'s `listOpenPrs` (in `src/monitoring/greenPrAutomergeWiring.ts`) ran one `gh pr list --author @me --limit 100 --json …statusCheckRollup` call per tick. That asks GitHub for up to 100 PRs in one GraphQL page, each with all its checks. With 60 authored open PRs (102 open in the repository) the page outran GitHub's ~10 s GraphQL budget and every call returned `HTTP 502`. Three failed ticks opened the breaker, and a PR that had passed Local Verify was not merged.

The listing now lives in `src/monitoring/greenPrOpenPrList.ts`: `listOpenPrRowsPaged()` reads 15 PRs per `gh api graphql` call (`OPEN_PR_LIST_PAGE_SIZE`), follows the cursor, keeps only PRs authored by the authenticated account, stops at the same 100-PR limit, and returns each PR in the row shape `gh pr list --json` printed (`ghRowFromGraphqlPr`), so `mapPr` and the merger are unchanged. A failed or unreadable page throws, as the failed single call did, so the tick-failed breaker and the fail-toward-not-merging behaviour are unchanged.

This is the same fault PR 3130 fixed for Local Verify's reconciler, in the second place that had it.

## What to Tell Your User

Nothing changes that you will see on a normal day. When many changes are open at once, the step that merges tested changes keeps working, where before it could quietly stop until someone noticed.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Auto-merge open-PR listing read in 15-PR pages | Automatic |

## Evidence

Studio, 2026-11-13: `state/green-pr-automerge.json` showed `lastSuccessfulListAt` 12:54:59Z and `breaker.open: true, consecutiveTickFailures: 3, openedAt` 13:41:44Z. `logs/local-verify.jsonl` 13:51:16Z: `merge-handoff-result` for PR 3127, `outcome: "breaker-open", acted: false`. The same command by hand: `HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)` after 11 s, twice; with `--limit 50` it succeeded in 10 s, with `--limit 25` in 4 s.

The paged read against live GitHub at 25 a page: 60 authored PRs across 5 pages in 12.9 s, and 16.8 s on the reviewer's run with one page at 6.1 s, which is why the shipped page size is 15. `mapPr` output was identical between the old command's rows and the paged rows for all 59 authored PRs, in the same order.

Run live on the Studio as a hot patch (at 25 a page) from 14:11Z: the next tick listed successfully and PR 3127 merged at 14:18Z.

Tests: `tests/unit/green-pr-open-pr-list.test.ts` (20, new): cursor following and order, the author filter, the 100-PR limit, six kinds of failed or unreadable page, the page cap, and row parity for `mapPr` (success, pending, failure with completion time, status-only, no rollup, bot author). `tests/unit/green-pr-automerge-wiring.test.ts` (24) updated to the paged call; `tests/e2e/merge-line-author-eligibility-lifecycle.test.ts` and `tests/e2e/green-pr-agent-stop-release-lifecycle.test.ts` drive the production wiring through the paged call.
