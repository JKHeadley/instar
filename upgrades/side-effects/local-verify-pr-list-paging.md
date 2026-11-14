# Side-Effects Review — Local Verify reads open PRs in small GraphQL pages

**Version / slug:** `local-verify-pr-list-paging`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, a narrow bug fix. `listOpenPrs` in `src/localVerify/reconcilerSeams.ts` (the status reconciler's open-PR read, which feeds the Local Verify queue and status posts) used to run `gh pr list --base main --state open --limit 1000 --json …statusCheckRollup`. gh fetches that 100 PRs a page. With 102 open PRs (2026-11-13) the 100-PR page, with each PR's checks, took longer than GitHub's ~10 s GraphQL budget, and every call returned `HTTP 502 Bad Gateway`. From 03:50 UTC every reconciler pass logged `list-failed` and backed off (4, 8, then 15 min), the queue admitted nothing new, and waiting PRs (3108 among them) stopped being offered. Reproduced by hand: `--limit 30` took 3.2 s; the default 100-PR page failed after ~11 s.

The read is now `gh api graphql --paginate --slurp` with a fixed query (`OPEN_PRS_QUERY`), 25 PRs a page (`OPEN_PR_PAGE_SIZE`). It asks for the same fields: number, head oid, base/head ref, cross-repo flag, author, and the last commit's `statusCheckRollup.contexts(first: 100)`. The output keeps `gh pr list`'s shape: a bot author becomes `app/<login>`, and an unfinished check's `null` conclusion becomes `''`. Live: 97 open PRs on main in 4 pages, ~7 s. Compared field by field with `gh pr list --limit 30`: 30 PRs, 0 differences. Test fakes in `tests/integration/local-verify-routes.test.ts` and `tests/e2e/local-verify-lifecycle.test.ts` now answer the new call. The new `tests/unit/localVerify/reconcilerSeams-listOpenPrs.test.ts` (7 tests) covers paging, shape parity, bot authors, truncation, failure cases and the empty list.

## Decision-point inventory

- `reconcilerSeams.listOpenPrs` — modify — a read; no decision logic changed. Its consumer, `StatusReconciler.passInner`, is unchanged.

---

## 1. Over-block

No block/allow surface. The read now fails (null) in more malformed-input cases: a page with GraphQL `errors`, a page without a `pullRequests` connection, or a node without a numeric `number`. Each of these was either impossible or silently mis-parsed with `gh pr list`. A null read only makes the pass back off; it is never read as "no PRs".

---

## 2. Under-block

As a read it can still fail: a GitHub outage, or a single 25-PR page outrunning the budget. That would need PRs with very large check lists; today a page takes ~1.5 s against a ~10 s budget. It behaves exactly as before: null, `list-failed`, backoff. Known adjacent risk, not changed here: the green-PR auto-merger's own list (`greenPrAutomergeWiring.listOpenPrs`) uses `gh pr list --author @me --limit 100` with `statusCheckRollup` and more fields. It covers 55 PRs today (5.5 s) and would hit the same budget near 100 of its author's open PRs.

---

## 3. Level-of-abstraction fit

Right layer: the fault is in how one GitHub read is fetched, and the fix is inside that read's seam, below the reconciler's logic. The output type is unchanged, so no consumer moves.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface. It restores a read that the existing gate depends on; the gate's authority and logic are unchanged.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point added. The page size is a transport constant.

---

## 5. Interactions

- **Shadowing / double-fire:** none; the same single call site, called once per pass.
- **Races:** none new; read-only.
- **Runner limits:** the shared runner caps each `gh` call at 30 s and 16 MB. A paged read runs in one `gh` process: ~7 s today, and output for 97 PRs is well under 1 MB.
- **Rate limit:** about 4 GraphQL requests per pass instead of 1–2 heavier ones. GraphQL points are charged per node requested, so the cost is about the same.
- **Ordering:** newest first (`CREATED_AT DESC`), the same as `gh pr list`. `passInner` groups by head and does not depend on order.

---

## 6. External surfaces

- Other agents / install base: the change ships in the server, but only the agent that holds the Local Verify lease (the instar maintainer's) runs this read. Other agents have Local Verify off.
- External systems: read-only GitHub GraphQL, same identity resolver as before.
- Persistent state: none.
- Operator surface: none.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN**: the read runs only on the lease holder, which is already single-writer for the queue. GitHub is the shared source. No notices, no durable state, no URLs.

---

## 8. Rollback cost

Pure code change: revert and release. No state or migration. A revert brings back the 502s whenever more than ~100 PRs are open.

---

## Conclusion

Narrow fix to a read that stopped all Local Verify admission. Verified against live GitHub (97 PRs, ~7 s) and for exact output parity with the old command (30 PRs, 0 differences). Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude)
**Independent read of the artifact: concur**

Concur with the review. Ran the real query read-only against JKHeadley/instar: 4 pages, ~6.4 s, 98 PRs, 98 unique, matching GitHub's own `totalCount` of 98, with every PR from `gh pr list --limit 30` present. The nested `contexts { pageInfo { hasNextPage } }` does not confuse gh's cursor discovery: the outer `pageInfo { hasNextPage endCursor }` comes first, the cursors are correct, and the last page has `hasNextPage: false`. Output matches what every consumer reads (`StatusReconciler.ts:471` rollupTruncated; `:558` author, isCrossRepository, headRefName, headSha, baseRefName); an unfinished check's null conclusion becomes `''` as `gh pr list` gave; truncation still fires at 100 and now also on a next page (stricter). Failure paths all return null, never a partial list (a mid-pagination failure makes gh exit non-zero). The test fakes are right; the e2e fake's old `pr` branch is now unused and harmless. The auto-merger's own list (§2) is a real adjacent risk at ~100 of its author's PRs.

---

## Evidence pointers

- `.instar/logs/local-verify.jsonl` on the lease holder: `list-failed` / `pass-backoff` from 2026-11-13T03:50Z.
- Manual repro: `gh pr list --repo JKHeadley/instar --base main --state open --limit 1000 --json …statusCheckRollup` → `HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)` after ~10.7 s.
