# Side-effects: machine removal survives Echo's real size

## Summary

A timed run on a real Studio and M5 pair with 186 records could not remove a machine: every attempt stopped with a lost lease. Two chains of synchronous work blocked the main thread for 33 to 58 seconds, longer than the lease renewal allows. One was an fsync of about 2,700 files in a walk. The other was a per-record source read whose awaits never reached the event loop. Now files are flushed off the main thread before the checks run, the checks use the existing flush memo, and each source read yields for real. The page also keeps "Finish removing" when the agreed view is unavailable, which is the state a stopped removal causes.

Decision point: none added. Every safety check still runs, in the same order.

## 1. Over-block
No issue identified. Nothing is refused that was accepted before; removals that failed now finish.

## 2. Under-block
A check that read a file now skips its fsync only if this process already flushed those exact contents, using the same stamp as the existing memo (identity, size, modified and changed times). Removal stays slow per record because of repeated checks; this change stops it blocking, not its cost.

## 3. Level-of-abstraction fit
The memo already owns "flushed by this process". The source read is the shared step every per-record loop goes through, so the yield belongs there.

## 4. Signal vs authority compliance
Follows `docs/signal-vs-authority.md`: no new authority. Yielding lets other work run between reads, and each read starts with the full check, so a change made during the yield is refused.

## 5. Interactions
The lease renewal, the server and the worker now run during a removal; the agent stays responsive at about 2 seconds. Preflush failures are left unremembered, so the check that reads that file flushes it itself. The page reads status on the local-only view too, which adds one request.

## 6. External surfaces
The owner sees "Finish removing" after reloading a stopped removal. No wire change.

## 6b. Operator-surface quality

1. **Primary action first:** after a stopped removal the page says the agreed view is unavailable, then shows the held state and "Finish removing" below the create control. Nothing on this page can make the agreed view return except finishing the removal.
2. **No raw internals:** plain sentences only. The failure code stays in logs.
3. **Destructive action de-emphasized:** the finish button is a quiet inline control and opens the same sheet as before.
4. **Plain language at phone width:** driven in a real browser at 390 wide against the real stuck pair, and the page text read at 390 and 1280.

## 7. Multi-machine posture
Machine-local: flush state is per process. Removal already runs on the surviving machine.

## 8. Rollback cost
Revert the commit. No state or format change.

## Class-Closure Declaration
Defect class: unbounded-self-action. Closure: n/a. No new trigger or loop; existing work yields more often.

## Evidence
Before: three attempts failed in 74 to 97 seconds with the lease lapsed, and the server log recorded a blocked event loop of 33 to 58 seconds. After: the same stuck removal, retried through the dashboard on one confirmed server, kept its lease for at least 30 minutes with the agent answering in about 2 seconds. An earlier reading of ten minutes is discarded because old test servers were still running on that home. The per-read check made it very slow; see `conversation-graph-held-read-recheck.md`. Unit: `tests/unit/graph-durable-file-memo-trees.test.ts`, and a dashboard case for the finish control.

## Second-pass review
Not required for the yields and memo use; the full removal suite reruns before merge.
