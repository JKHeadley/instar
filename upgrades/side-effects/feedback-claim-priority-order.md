# Side-effects review: the feedback consumer claims the most important work first

## What changes
`FeedbackDrainStore` (src/feedback-factory/drain/FeedbackDrainStore.ts) gains `WORK_CLAIM_ORDER`:
- high priority first (case-insensitive; 'high' means 5 or more reports);
- then the most-reported;
- then the oldest by `first_seen_at`, `created_at` and `work_id`, as before.

It replaces the old oldest-first `ORDER BY first_seen_at,created_at,work_id` in three places: `claimNext` (both the approved-ids and the open variants) and `claimableWork`, the read-only preview the consumer-promotion proposal is built from. Because claiming and preview share the constant, the batch an operator approves is still exactly the batch that gets claimed.

## Why
On 2026-11-27 the pending Promote proposal (the operator's one approval to take feedback processing out of practice mode) held the 10 oldest queued items: all normal priority, one report each. Meanwhile 18 high-priority items waited behind them, many reported by agents on other users' machines with large counts:
- 1,768 reports: JobRunHistory row cap;
- 1,463: QuotaCollector OAuth 429;
- 1,461: unjustifiedStopGate timeout;
- 309: a broken better-sqlite3 module.

The purpose the operator set is to work the highest-priority issues first. The Chief of Staff held the ask until the batch is ordered by importance.

## Behaviour
- Which items are claimed, and when, follows the new order. Nothing else changes: claim exclusivity, leases, approved-batch exclusivity (`outstandingApprovedWork`), retries and the promotion hash rules.
- A promotion proposal already on display gets a new proposal set hash once the server runs this code, because its ids change. No approval exists for the old set, so none is invalidated.
- `simulateClaims`, which exercises the claim machinery in an in-memory database, keeps its own order. It is not used for real claims.

## Risks considered
- **Starvation of normal work:** normal items are claimed whenever no high item is due; high work is a small share (18 of 354 today). Age still breaks ties.
- **Rollback:** revert this commit.

## Tests
`tests/unit/feedback-drain-store.test.ts` gains three cases:
- high priority is claimed before older normal work, and more reports before fewer;
- the promotion preview lists work in exactly the order `claimNext` claims it;
- priority comparison is case-insensitive.

The existing "oldest first when rows are enqueued in the same clock tick" case, with equal priority and report count, still passes. Results: tsc exit 0; the feedback drain and promotion unit files pass; `feedback-drain-backup-restore` integration passes; all 26 ratchet files pass.

## Second-pass review

**Reviewer:** echo-pipeline-strategy (Pipeline Strategy session, independent and read-only; it ran no tests)

- **2026-11-27 11:27 PT, commit b46cf1526ef806186f8569c96317efef9ae469ae: CONCUR.**
  - The approved set equals the claimed set: `claimNext` with `onlyWorkIds` still restricts claiming to the approved ids, and `claimableWork` uses the same `WORK_CLAIM_ORDER`. The promotion hash sorts ids before hashing, so it depends on the set, not the order. `outstandingApprovedWork` is a set filter and is unaffected.
  - No starvation beyond windows while high-priority work is due: retryable items keep their backoff gate and dead-letter after their attempts.
  - No other dependency on the old order: `oldestQueuedAgeMs` uses `MIN(created_at)`, and `simulateClaims` keeps its own order.
  - This note is accurate on every point checked. Within high priority, `report_count DESC` can move a fast-growing item ahead of an older one, which is intended.
- **2026-11-27 22:38 PT, staged main-merge tree d341d05417dc5febad58ecd040e19f72db2bc704 (committed as 4146eea524): CONCUR.**
  - Exactly the 7 PR paths differ from main 482a94b9, each identical to b46cf1526e.
  - The release note is at `upgrades/next/feedback-claim-priority-order.md` with no root copy.
  - The src and tests changes against main are byte-identical to b46cf1526e's against its base, with matching patch ids.
  - No shipped upgrades guide differs from main.
  - Review file: `.instar/state/handoffs/reviews/second-pass/echo-pipeline-strategy-4014-main-merge.md` (agent home).
- **2026-11-28 01:48 PT, the fixture reconciliation after the full Studio gate failed on `tests/integration/feedback-drain-performance.test.ts:35`: CONCUR (after one CONCUR-with-conditions round).**
  - The failure was the intended behaviour: the tick's own clustering readies one high-priority cluster of about 500 reports, which now outranks the seeded normal, 1-report items.
  - The fixture keeps those items unchanged and now asserts the full order: the cluster first, the oldest seeded item second, the newer third. That shows old, lower-ranked work still drains in the same tick, oldest first within a rank.
  - The 500-row envelope, the concurrent ingest and the lag checks are untouched.
  - Acceptance criteria 13 and 16 in `docs/specs/feedback-factory-operating-drain.md` now say highest-ranked first, oldest within a rank. Lower-ranked work has no hard age bound; aging and the `simulateClaims` alignment are tracked as CMT-2388.
  - Notes: `.instar/state/handoffs/reviews/second-pass/4014-fixture-reconciliation.md` (agent home).
