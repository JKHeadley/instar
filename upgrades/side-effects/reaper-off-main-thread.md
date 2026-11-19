# Side-Effects Review — The worktree reaper stops blocking the server

**Version / slug:** `reaper-off-main-thread`
**Date:** `2026-11-18`
**Author:** `echo (echo-machine-stewardship)`
**Second-pass reviewer:** `independent subagent`

## Summary of the change

`AgentWorktreeReaper.evaluate()` is synchronous: git status, ls-files, cherry, gh, ps and lsof, all through execFileSync. Every pass evaluated every checkout under `<home>/.worktrees` on the event loop.

Measured on the Studio on 2026-11-18 in a separate read-only process: a 40-checkout sample took 6.9 s, a mean of 173 ms. That projects to about 45 s per pass over 258 checkouts. The pass runs 15 min after every boot and then daily, and every read of `GET /worktrees/agent-reaper` re-evaluated synchronously (fb-91e824f4-920). The Chief of Staff asked for this fix separately and first (msg 0314fb4b).

The change follows the pattern of the hourly backup (PR 3134):
- **New:**
  - `agentWorktreeEvaluationJob.ts`: `runAgentWorktreeEvaluation`, which builds the same production deps from plain options, runs the same `prepare()` and `evaluate()`, and cannot remove;
  - `evaluateAgentWorktreesInWorker`, which runs that in a `worker_threads` worker. It never rejects: a failure, an early exit or a timeout resolves `{ ok: false }`;
  - a trivial worker entry.
- **The reaper's new optional dep `evaluateAllOffThread`:** a pass that removes nothing (dry-run, or the reaper disabled) uses it and never lists or evaluates on the main thread. The evaluations are kept in memory. A failure goes through the existing enumeration-failure path: reclaimable unknown, `verdictUnknown`, failure history.
- **`report()`** answers the route from the last pass. Without the dep it keeps the old behaviour, so tests and other wirings are unchanged.
  - With no pass yet, it runs one in the worker and waits for it. The event loop stays free, but the first request can take a whole pass, about 45 s on the Studio.
  - A last pass older than the reap interval, or a failed one, is refreshed in the background, and that answer says `passRunning: true`. This way a disabled reaper, which has no timer, never serves one answer forever.
  - A live reaper (`dryRun: false`) is never driven from a read. A GET cannot start a removal.
  - A failed pass is retried from a read only after a backoff, so polling cannot inflate the failure count.
- **A live pass (`dryRun: false`)** keeps the in-process path, because removal needs its main-thread re-check (`reclaimRaceGuard`). That path is dark on every agent today.
- **The worker's environment** is the server's own. `gh` authenticates through `GH_TOKEN`; with a stripped environment, every squash-merged checkout would read as unmerged.
- **Watchdog:** a worker still running after 30 min (about 40 times the measured pass) is ended, and the pass counts as a failure. Without it, a worker stuck in an unbounded filesystem call would keep the overlap guard set and silently skip every later pass.

## Decision-point inventory

- Which path a pass takes: invariant, `killsEnabled` (`enabled && !dryRun`) and whether the dep is wired.
- Every verdict comes from the same `evaluate()`.

## 1. Over-block

None.

## 2. Under-block

A live pass still blocks the main thread, unchanged. That is tracked in the topic-worktree-reclaim spec (phase 2, topic 144503).

## 3. Level-of-abstraction fit

Same seam and pattern as `backupSnapshotJob`. The reaper keeps the loop, breaker, evidence and failure history on the main thread; the worker only evaluates.

## 4. Signal vs authority compliance

Report only. No removal path changes.

## 5. Interactions

- The overlap guard (`running`) still covers the off-thread pass.
- On a disabled reaper, a route read can now start a dry-run pass: at most one at a time, only when there is no pass younger than the reap interval, and a failed pass is retried no sooner than 5 minutes (or the reap interval, if shorter) after it failed. That pass writes one `featureEvidence` row, and if it fails, one failure-history entry. Today's route read had no side effects. This is bounded, and recording evidence is that log's purpose.
- `guardStatus()` reads the same in-memory fields.
- The disk-steward child's own read-only reaper is unchanged.
- The worker's `withSyncOp` markers are per-thread and do not mark the main thread as blocked.

## 6. External surfaces

`GET /worktrees/agent-reaper` gains three fields: `evaluatedAt`, `source` (`last-pass` or `live`) and `passRunning`. It now answers from the last pass instead of re-evaluating. Existing fields are unchanged.

## 6b. Operator-surface quality

The route says how old the evaluation is.

## 7. Multi-machine posture

Machine-local by design: `machine-local-justification: hardware-bound-resource`. Each machine evaluates its own disk's checkouts.

## 8. Rollback cost

Revert. The cache is in memory only.

## Conclusion

Removes a measured ~45 s event-loop block per pass, with identical verdicts.

## Second-pass review (if required)

Round 1 raised concerns, all fixed:
1. **A GET could start a live removal pass.** `report()` only starts a pass when the reaper cannot remove (`!killsEnabled`). A test covers a live reaper: no list, no removal.
2. **A disabled reaper's report went stale forever,** and a failed first pass blocked any retry. A stale or failed last pass is now refreshed in the background (`passRunning`). A test covers both.

Round 2 raised one concern, now fixed: a failed pass was retried on every read. It now waits for a backoff (`FAILED_PASS_RETRY_MS`, 5 min, or the reap interval if shorter), and a test checks that a read inside the backoff starts no retry. The garbled counter comment is rewritten.
3. **Smaller items:**
   - the counter comment is updated;
   - §5 and §6 now state the side effects and the first-read wait;
   - `report()` is moved below `prepare()`.

The reviewer also checked and found fine:
- the worker URL in the built dist (ran it against a real repo, exit code 0);
- structured clone;
- same verdicts;
- `guardStatus`;
- no other `snapshot()` callers;
- the full `process.env`;
- the lints.

## Evidence pointers

- `tests/unit/agent-worktree-reaper-off-thread.test.ts`: 11 pass (adds: no pass from GET on a live reaper; background refresh of a stale or failed pass). Covers:
  - the dry-run pass going off-thread;
  - the report from cache;
  - the first report running a pass while disabled;
  - a failure reading as unknown;
  - a live pass staying in-process;
  - the old shape without the dep;
  - the watchdog ending a hung worker;
  - an early exit;
  - the real worker body on a real git repo.
- The existing `agent-worktree-reaper.test.ts` passes: 112 together.
- `tsc` is clean.
- The integration and e2e route tests run in Local Verify.

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a`
- **reason:** request-driven, not a self-triggered loop.
  - `report()` starts a dry-run pass only on a GET of `/worktrees/agent-reaper`.
  - Only one pass runs at a time, enforced by the existing overlap guard.
  - A failed pass is retried at most once every 5 minutes (`FAILED_PASS_RETRY_MS`).
  - The reaper's own timer is unchanged.
