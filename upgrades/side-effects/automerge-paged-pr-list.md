# Side-Effects Review — the auto-merger reads its open PRs in small GraphQL pages

**Version / slug:** `automerge-paged-pr-list`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, a narrow bug fix. `listOpenPrs` in `src/monitoring/greenPrAutomergeWiring.ts` (the GreenPrAutoMerger's per-tick read of the agent's open PRs) ran one `gh pr list --author @me --state open --base main --limit 100 --json <LIST_PR_JSON_FIELDS> --search sort:created-asc`. gh fetches that as one 100-PR GraphQL page carrying every PR's check rollup. At 60 authored open PRs (102 open in the repo) the page outran GitHub's ~10 s GraphQL budget: `HTTP 502` on every tick from 2026-11-13 12:55Z, breaker open at 13:41Z, and a Local-Verify-passed PR (3127) was refused at handoff with `breaker-open`.

The read is now `listOpenPrRowsPaged()` in the new `src/monitoring/greenPrOpenPrList.ts`: one `gh api graphql` call per 15-PR page (`OPEN_PR_LIST_PAGE_SIZE`), cursor-followed, oldest first, filtered to the authenticated account's PRs (`viewer.login`), capped at the same 100 rows (`OPEN_PR_LIST_LIMIT`) and at 40 pages (`OPEN_PR_LIST_MAX_PAGES`, 600 open PRs). Each node is converted by `ghRowFromGraphqlPr()` to the row `gh pr list --json` printed, then goes through the unchanged `mapPr`. Any failed or unreadable page throws.

Files: `src/monitoring/greenPrOpenPrList.ts` (new), `src/monitoring/greenPrAutomergeWiring.ts` (the one seam + import + a comment), tests.

## Decision-point inventory

- `buildGreenPrDeps().listOpenPrs` — modify — a read. No decision logic changed. Its consumers (`GreenPrAutoMerger.tick`, the red-PR watchdog, the snapshot) are unchanged and receive the same `PrSummary[]`.

---

## 1. Over-block

The merger acts on nothing when the read fails, so "over-block" here means the read failing more often than before. New failure cases: a page with GraphQL `errors`, a missing `viewer.login`, a missing `pullRequests` connection, a null or number-less node, `hasNextPage` without a cursor, unparseable output, more than 40 pages. Each of these means the list cannot be trusted as complete, and failing is the intended behaviour: the old call failed whole too. GraphQL `errors` alongside partial data is treated as failure even if the data looks usable; that is deliberate (a partial list could hide a PR whose state matters to the red-PR watchdog).

## 2. Under-block

- The read can still fail on a GitHub outage, or if a single page outruns the budget. Measured at 25 PRs a page: 0.7 to 6.1 s a page (two runs, 2026-11-13) against ~10 s; the page size is therefore 15, not 25.
- **Check contexts beyond 100 per PR are not read** (`contexts(first: 100)`), exactly as `gh pr list` did not read them. A PR with more than 100 check contexts could show a rollup missing a failing check. This does not widen what merges: `safe-merge` re-reads every check at act time and is the authority. No PR in the repo is near 100 contexts today (largest observed on 2026-11-13: 47).
- **The author filter moved client-side.** `gh pr list --author @me` filtered on GitHub. The paged read compares each node's `author.login` to `viewer.login` from the same response. A PR whose author is null (deleted account) is dropped, as GitHub's filter dropped it.
- **Labels beyond 50 per PR are not read.** The hold-label check reads labels; a PR with more than 50 labels could hide a hold label from the list read. The largest label count on an open PR on 2026-11-13 was 2. How many labels `gh pr list` itself read was not checked.
- The 100-row limit now counts authored PRs after scanning; the old limit was the same (author-filtered server-side). No change.

## 3. Level-of-abstraction fit

Right layer: the fault is in how one GitHub read is fetched; the fix is inside that read's seam, below the merger's logic, and keeps the seam's output type. A shared paged reader for both this seam and Local Verify's reconciler (PR 3130) was considered and not done: the two read different field sets, different author scopes and opposite orders, and return different types; sharing would couple the merge gate's input to the verifier's.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No new block/allow surface. The list read is an input to the existing gate; `safe-merge` remains the act-time authority and is untouched. The read's fail-closed behaviour (throw → tick-failed → breaker) is preserved, not added.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point added. Page size, page cap and row limit are transport constants.

## 5. Interactions

- **Breaker:** a thrown read feeds `tick-failed` exactly as before (every error the reader raises begins `gh pr list failed: page N:`; nothing in `src` or `scripts` matches on that text). A multi-page read now has several chances to fail in one tick; one failure fails the tick once.
- **gh runner limits:** each call is capped at 30 s and 32 MB by `createAuthenticatedGhExec`. Each page is its own call (up to about 6 s and 130 KB at 25 PRs; less at 15), so the cap applies per page. A single `--paginate` call was measured at 18 s for 5 pages and would have come close to the 30 s cap; that is why pages are separate calls.
- **Tick duration:** 13 to 17 s for 60 authored PRs at 25 a page (two measurements), against about 10 s when the single call worked; 15 a page makes more, smaller calls for a similar total. Ticks are single-flight; cadence is minutes.
- **Rate limit:** one rate-limit point per page, so about 7 per tick at today's size (102 open PRs on main) against about 1 before. Negligible against 5,000 an hour (remaining during the incident: 4,448).
- **Repository:** the old command took its repository from the working directory; the paged read uses `opts.repo`, the same value every other read in this wiring already uses (`repos/${opts.repo}/…`).
- **Unset times:** GraphQL returns `null` for an unfinished check's `completedAt`; `gh pr list` printed Go's zero time (`0001-01-01T00:00:00Z`). The row keeps gh's value (`GH_ZERO_TIME`) so `latestRunPerCheck` orders runs exactly as before.
- **Token type:** the author filter compares `author.login` with `viewer.login`. With a GitHub App installation token the two could fail to match and the list would be empty (nothing merges; nothing wrong merges). The merger runs on a user token; `gh pr list --author @me` had the same dependence on the signed-in identity.
- **Consistency across pages:** a PR opened or closed between page reads can shift the cursor window. Cursor pagination is stable against this for `CREATED_AT ASC` (new PRs append at the end; a closed PR drops out without shifting earlier cursors). Worst case a just-closed PR appears in the list for one tick, or a PR reopened behind the cursor mid-read is missed for one tick; `refetchPr` and safe-merge re-read state before acting.
- **`LIST_PR_JSON_FIELDS`:** still exported; it is now the pinned key list of each returned row (a test asserts `Object.keys(ghRowFromGraphqlPr(..))` equals it, in order) rather than a `--json` argument.
- **Unknown-field drift reporting:** `reportUnknownGhJsonField` was never wired to the list call (only to `refetchPr`); nothing lost.

## 6. External surfaces

- Other agents / install base: ships in the server, but only an agent with the green-PR auto-merger enabled on an instar checkout runs this read (the instar maintainer's).
- External systems: read-only GitHub GraphQL, same identity resolver as before. The query adds `viewer { login }`.
- Persistent state: none. Operator surface: none.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN**: the merger acts only on the lease holder (`holdsLease`), GitHub is the shared source, and the read keeps no state. No notices, no durable state, no URLs.

## 8. Rollback cost

Pure code change: revert and release. No state or migration. A revert brings back the 502s whenever the single 100-PR page is too heavy.

---

## Conclusion

Narrow fix to a read whose failure stopped all merging. Verified against live GitHub (60 authored PRs, 5 pages of 25, 12.9 s), for `mapPr` parity with the old command's rows (30 oldest PRs by the author, then all 59 by the reviewer: 0 differences, same order), and live on the Studio as a hot patch (first tick after it listed successfully; PR 3127 merged at 14:18Z).

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude), given the code and not the author's conclusions
**Independent read of the artifact: concur**

Concur, no blockers. The reviewer ran the paged read and the old `gh pr list --limit 100` within seconds of each other against JKHeadley/instar (106 open PRs, 101 on main, 7 authors, 12 drafts, 11 fork PRs): both returned the same 59 PRs in the same order, and `mapPr` output was identical for all 59. Rollup entries matched on name, context, status, conclusion, state, startedAt and workflowName.

Findings, all addressed in this change:

1. An unfinished check's `completedAt` was `null` where gh printed `0001-01-01T00:00:00Z` (67 entries; no `mapPr` difference). The row now keeps gh's value.
2. `JSON.parse` of a page was unguarded (a bare `SyntaxError` with no page number, still caught by the tick). It now raises `gh pr list failed: page N: unparseable output`.
3. Headroom: the reviewer's pages took 2.5, 3.7, 6.1, 3.7 and 0.7 s, so "about 3 s a page" was wrong and 25 a page left less room than stated. Page size is now 15 and the numbers above are corrected.
4. The "next page with no cursor" test would have passed without the guard. Every failed-page case now asserts the `page 1:` message and that no second call was made.
5. Misstatements corrected above: the error-text prefix, the rate-limit cost, the per-page time.

Not checked by the reviewer: the two e2e files and the full suite, gh's own page sizes for labels and contexts, a GitHub App token.

---

## Evidence pointers

- `state/green-pr-automerge.json` on the Studio, 2026-11-13: `lastSuccessfulListAt` 12:54:59Z; `breaker.openedAt` 13:41:44Z, `consecutiveTickFailures: 3`.
- `logs/local-verify.jsonl` 13:51:16Z: `merge-handoff-result` PR 3127 `outcome: "breaker-open"`.
- Manual repro: the old command → `HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)` after 11 s (twice); `--limit 50` 10 s ok; `--limit 25` 4 s ok.
