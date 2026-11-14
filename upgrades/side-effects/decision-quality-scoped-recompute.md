# Side-Effects Review — the decision-quality bucket recompute ranks only its own bucket's outcomes

**Version / slug:** `decision-quality-scoped-recompute`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `not required (a query rewrite inside an observability ledger; no decision point)`

## Summary of the change

Tier 1 (one source file, two SQL statements; no schema or stored-data change; a revert undoes it). 1 source file, 1 new test file. No spec review rounds; one commit attempt expected.

Each outcome upsert recomputed its rollup bucket through the `decision_winning_grade` view, which ranks the whole `decision_outcomes` table before any restriction: about 100 ms per query at 61,683 outcomes, twice per upsert, up to 200 upserts in one synchronous grading pass. On 2026-11-13 13:00Z that held the server's event loop for over 70 s at 89.5% CPU and the supervisor killed it.

Change: the two recompute statements rank only the outcomes of decisions in the bucket, using the same ranking text the view is built from.

Another cause of the server kills tracked under CMT-1718 (after the busy-note writes, the hourly backup copy, the usage scan and the per-session tmux calls).

## Decision-point inventory

None. The ledger measures decisions made elsewhere; nothing reads these rollups to gate anything. The winning-grade precedence rule is unchanged and still has one definition.

## 1. Over-block

No issue identified.

## 2. Under-block

- A grading pass still writes up to `maxDecisionsPerPass` outcomes synchronously on the main thread; at 1 to 5 ms per recompute statement that is on the order of a second or two, not a minute.
- Other consumers of the view (the daily and by-model reads over a window, `getWinningGrades`, the reconcile) are unchanged. They run on request or on their own cadence, not per outcome; the reads over a window still rank the whole outcomes table once per call.
- The recompute's cost now grows with the bucket (the decisions of one point on one day), not with the table. A very large bucket (tens of thousands of graded decisions in a day) is ranked in full per upsert.

## 3. Level-of-abstraction fit

The fix is in the two statements that had the cost. Changing the view itself would not help: SQLite cannot push the outer restriction below a window function, which is why the restriction has to be written inside. Batching the recompute per grading pass is a possible further step; with this change it is no longer needed for the freeze.

## 4. Signal vs authority compliance

Not a decision point. The rule that decides a winning grade is not reimplemented: `WINNING_GRADE_RANK_SQL` is the single text, used by the view's DDL and by the scoped subquery; a test asserts both contain it.

## 4b. Judgment-point check

Not applicable.

## 5. Interactions

- **Existing databases.** The view is created with `CREATE VIEW IF NOT EXISTS`, so an existing view is untouched; its text is the same as before apart from whitespace in a freshly created database.
- **The reconcile** recomputes buckets through the same two methods and gets the same faster path.
- **Named parameters.** The two statements moved from positional to named bindings; nothing else binds them.

## 6. External surfaces

None. Two new exported constants (`WINNING_GRADE_RANK_SQL`, `BUCKET_WINNING_GRADE_SQL`), used by the tests.

## 7. Multi-machine posture

Machine-local by design and unchanged: each machine recomputes its own ledger's buckets; cross-machine reads are merged above this layer.

## 8. Rollback cost

Revert the commit. The rollup tables are derived and are recomputed from the records either way.

## Verification

Random-data equivalence against the view on both rollup tables (three seeds, day-edge timestamps included); identical counts on six real buckets of the Studio's live database, read-only; query-plan assertion; three introduced faults caught.

## Conclusion

Removes a full-table ranking from every outcome upsert with no change in any number. Ship ahead of ordinary work: it is a measured cause of the server being killed.
