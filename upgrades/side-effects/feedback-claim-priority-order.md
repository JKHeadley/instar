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
