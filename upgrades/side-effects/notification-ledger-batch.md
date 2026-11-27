# Side-effects review: the notification decision ledger batches a burst into one write

## What changes
`NotificationSelectivityGate.ledger()` (src/messaging/NotificationSelectivityGate.ts) used to chain one `mkdir` and one `appendFile` per decision row onto `ledgerWrites`. Now rows go into `ledgerPending`. Only the first row of a burst schedules a write, and that write takes every row pending at the moment it runs, then appends them as one chunk. A row that arrives after a write has taken its batch schedules the next write.

## Why
A 1000-send burst queued 1000 sequential `mkdir` + `appendFile` steps. `close()` awaits `ledgerWrites`, so closing the gate waited for all of them. Measured on the Studio in `tests/unit/notification-selectivity.test.ts`'s 1000-send case, the chain took 6.5 to 10.9 s under current load (everything else in close took under 0.4 s), past the 10 s afterEach hook budget. That failed a verification run of #3985 and a run of untouched main at 07:00 PT on 2026-11-27.

## Behavior
- Same rows, same order, same file and format.
- Rotation is still checked before each write. Because the check is per batch, a file can exceed the 2 MB cap by at most one batch before the next write rotates it.
- Error handling is unchanged: a failed write marks `ledgerHealthy` false and logs once. If a batched write fails, the whole batch is lost, as each single row was lost before.
- No route, response, setting or message changes.

## Risks considered
- **A row left unwritten:** while any row is pending, a write is scheduled that has not yet taken its batch. The first row of each burst schedules the write, and later rows join it until it runs. The new test covers a row arriving after a batch was taken.
- **Memory:** pending rows are held only until the next write runs, which is no longer than before, when they sat in the promise chain.
- **Rollback:** revert this commit.

## Tests
`tests/unit/notification-selectivity.test.ts` has a new case: 1000 rows queued together produce exactly one append, all rows in order, and a later row lands in a second append. The file passes 29/29 three runs in a row. The type check is clean.
