# Side-Effects Review — bound uncertified continuations in reconcilePending

**Version / slug:** `graph-continuation-bound`
**Date:** `2026-11-18`
**Author:** `Echo (echo-graph-event-loop-blocks, topic 144559)`
**Second-pass reviewer:** `independent general-purpose subagent (see below)`

## Summary of the change

Tier 1 (scheduling of a background retry; a revert fully undoes it). One source file + one test file.

`reconcilePending` runs under `withMutation`. Its loop already bounds resumed deliveries of certified records (after one does not finish, no other is tried that pass; per-record backoff `pass + min(2^(fails-1), 40)`). Uncertified records had no bound: each pass ran `validatedContinuation` (a full revalidation) and `coordinator.submit`/`cancel` for every one of them. Peer requests wait behind the lane, so on the accept-all rig a backlog of 50 uncertified source observations made every M5 `observe` time out (diagnosed by the accept-all session, 2026-11-18 03:54-04:00Z), and those observes were what would certify the records. The same bound now applies to uncertified continuations, with its own `continuationRetry` map sharing the pass counter: finish = `committed`, `canceled` or `commit-won` (clears the backoff); anything else (held, `saved-pending`, `recorded-local`, `checking-*`, `refused`) stalls the pass and backs the record off.

Both bounds now order the pass least-recently-tried first (a `tried` pass is stored on each non-finish; never-tried records first, then source order). Without that, a skipped record kept its place, and with ~40+ records that never finish (the backoff cap) some earlier record was due on every pass, so later records were never tried again (second-pass finding; the delivery bound had the same latent shape and gets the same rotation).

Third commit, same theme: the readiness pass checked `alive()` (instance lock + `trustedInstalledSet`, which reads the machine registry and identity files and re-verifies the signed membership) at the start of every manifest entry (~565 per pass): 8% of the long stretches on the rig after the other fixes. Most entries end at the "already settled" `continue` with no await. The check is now skipped only for the entry right after such an entry: nothing else ran in between, and the loop's own synchronous code (`repairRecord`, `assertRepairStillAllowed`, `settledRecords` lookups) changes none of `alive()`'s inputs, so the check would read the same state. After any await it runs as before. `alive()` itself is unchanged. (A first version remembered `alive()` for the whole synchronous run; main's integration test releasing the instance lock and checking `privateReadsServable()` in the same run showed that could hide a same-run change, so it was replaced by this loop-local skip.)

## Decision-point inventory

- Background retry scheduling for uncertified records — modify — from "every record every pass" to "until the first non-finishing one, with per-record backoff". Same as the existing delivery bound.

---

## 1. Over-block

Every record keeps being reached: the pass is ordered least-recently-tried first, so a record skipped this pass moves ahead of records tried more recently (unit test: 50 never-finishing records over 120 passes are all tried, and the later ones again); no record is dropped. Worst case a failing record is retried every 40 passes. User-initiated writes (`submitPrepared`) do not go through this loop and are unaffected.

## 2. Under-block

No safety surface: what is submitted and how it is verified are unchanged.

## 3. Level-of-abstraction fit

Same place and pattern as the existing delivery bound (PR 3278).

## 4. Signal vs authority compliance

- [x] No — no block/allow surface; it changes how many background retries run per pass.

## 4b. Judgment-point check

The backoff curve is the existing delivery curve, reused; not a new heuristic at a competing-signals point.

## 5. Interactions

`tests/integration` expectations on `reconcilePending`: single-record cases, and one two-record case where both finish (`committed`, `canceled`), so the bound does not trigger there. The certified-delivery bound is unchanged and independent (`deliveryStalled` vs `continuationStalled`).

## 6. External surfaces

None. Fewer peer calls per pass under a backlog.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local scheduling state (in-memory backoff per process), by design: each machine retries its own pending records; a restart resets the backoff, as for deliveries.

## 8. Rollback cost

Revert; no state.

## Conclusion

Ship as Tier 1.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (read-only), two reads, 2026-11-18 04:08-04:11Z
**Independent read of the artifact: concur** (after one concern was resolved)

First read: concern raised. With a fixed source order, a skipped due record kept its place, so with 40 or more never-finishing records the later ones were never tried again (the delivery bound had the same latent shape); also `commit-won` is final for cancels. Resolved: both bounds order least-recently-tried first, and `commit-won` counts as finished; a unit test covers 50 never-finishing records. Second read: concur. Remaining check it asked for: out-of-order attempts are safe because `ConversationGraphCommitCoordinator` returns only non-terminal states (`checking-save`, `saved-pending`) for anything missing upstream; its one `refused` is the record's own missing body, independent of order; attempts are idempotent; and among never-tried records source order still wins ties. Its minor note (retry entries for records that left the pending list were never removed) is fixed: entries not in this pass's list are pruned.

## Evidence pointers

- Rig diagnosis by the accept-all session (topic 144007), 2026-11-18 03:54-04:00Z; CPU profiles in topic 144559.
- Tests: `tests/unit/conversation-graph-continuation-bound.test.ts` — 4 passed.

**Second-pass review of the loop-local `alive()` skip** (independent general-purpose subagent, read-only, 2026-11-18 09:37Z): **concur.** The skip path awaits nothing (both awaiting blocks are under `if(!record)`); `repairRecord`, `repairLineage`, `assertRepairStillAllowed`, `descriptorFor` and `settledRecords.get` are reads or verify-or-throw and write none of `alive()`'s inputs; the flag is reset at the top of every entry and set only at the settled `continue`. Caveat recorded: `revalidate()` and `trustedInstalledSet()` read files another process could change mid-pass; the per-entry check could notice that a few entries sooner, now it is noticed at the next await (and the old code also stopped checking after the last entry), so what the loop returns is unchanged.
