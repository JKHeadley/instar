# Upgrade Guide — vNEXT

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

`tests/e2e/throughput-series-live.test.ts` stubbed a merged PR with literal dates (`createdAt: '2026-07-22T12:00:00Z'`, `mergedAt: '2026-07-23T12:00:00Z'`). The throughput route keeps only PRs where `cutoff <= mergedAt <= now` with `cutoff = now - days` (`src/server/throughputRoutes.ts:114-117`), so at `2026-07-30T12:00:00Z` the stub fell out of the rolling 7-day window, `rows` became `[]`, and the assertion failed. CI went red on every open PR within the hour, for a reason unrelated to any change in them.

The stub's dates are now derived from `Date.now()` — merged 24h ago, created 48h ago — so the test cannot expire. The 24h created-to-merged gap is preserved deliberately: `team.index` is derived from median latency, so changing the gap would move the expected value and force an assertion edit that was never wrong.

Diagnosis note worth keeping: a test that passes for a week then fails on a date is worse than one that simply breaks, because the failure arrives detached from any change, so the natural assumption is that your own work caused it. This fixture supplies its own data and reads no real repository state, which is what made the clock the only possible variable.

## Evidence

- Reproduced on a branch off freshly-fetched `origin/main`, confirming it is pre-existing and not caused by any in-flight PR: `rows: []` against expected `rows: [{ authors: { codey: { merges: 1 } }, team: { index: 80 } }]`.
- Boundary identified precisely: the literal `mergedAt` sat exactly 7 days before `2026-07-30T12:00:00Z`, which is when the failures began.
- After the fix: `npx vitest run tests/e2e/throughput-series-live.test.ts` gives 3/3 pass, with the `index: 80` assertion unchanged, proving the preserved 24h gap keeps the derived score identical.
- `safe-merge` independently refused to merge PR #1753 while these checks were red, so the merge guard behaved correctly throughout.
