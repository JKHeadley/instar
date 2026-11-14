# Side-Effects Review — the usage ledger lists transcript files off the main thread

**Version / slug:** `usage-ledger-async-scan`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 (a revert undoes it; no stored data, schema or config changes). 3 source files (1 new), 2 new test files. No spec review rounds; two independent review reads of the code (the first concurred with three should-fix findings, all applied).

`UsageLedger.scanTick()` listed every transcript under every root synchronously on a 60-second server timer: about 4,000 directory reads and 50,000 to 85,000 stats on the Studio. Measured there on a quiet disk it holds the event loop 0.7 to 1.9 s per tick. On 2026-11-13 02:36 PST, on a contended disk, a native sample shows the main thread inside that walk for the whole capture; the supervisor killed the server after about 70 s unresponsive.

Change: `scanTickAsync()` does the same listing through `fs.promises`; the server timer uses it through `createUsageLedgerTick` (`src/monitoring/usageLedgerTick.ts`), one tick at a time, with a listing that does not end reported in the log and the feature evidence. `dropMissingCheckpointsAsync()` does the hourly existence checks the same way. The synchronous methods stay and share `beginScanTick()` and `consumeScanQueues()` with the new path.

Third part of CMT-1718 (after the busy-note writes, PR 3133, and the hourly backup copy, PR 3134). Still open there: synchronous tmux and ps reads in the session monitor, and the supervisor's cleanup of a live verify child.

## Decision-point inventory

None. The ledger is observational: it gates nothing. The rules for which directories and files are scanned are unchanged and held to the synchronous version by a parity test.

## 1. Over-block

No issue identified. A minute tick that finds the previous tick still listing is skipped; the next tick lists from the same checkpoints, so nothing is lost, only read later.

## 2. Under-block

**Only the listing moved off the main thread.** Still synchronous there:

- Ingesting the changed files (up to `filesPerTick`, default 500): a head read and a read of the whole unread remainder per changed file, JSON parsing and the SQLite transaction, in one uninterrupted block. In steady state a few dozen files change per minute and only their new lines are read. With a backlog (a fresh or reset ledger database, a newly registered config home) that is 500 whole transcripts per tick for several ticks, which on a contended disk could itself exceed the supervisor's patience.
- The detail rescan after a same-machine snapshot import (`pendingDetailRescan`): every checkpointed Claude file re-read from the start, once, with no budget.
- The per-file checkpoint lookup in the changed-file filter is a synchronous SQLite read, done in batches of 32 between awaits.
- The hourly `prune()` and `writeSnapshot()` (a full copy of checkpoints, bindings and day rollups into a new file).
- Not addressed here: the other sources of main-thread blocking listed in the summary.

## 3. Level-of-abstraction fit

The fix is in the ledger, where the walk lives, not in the server. The walk is duplicated in a synchronous and an asynchronous form because the synchronous one is what the existing tests drive and is the reference the new path is held to; a parity test holds the two together.

## 4. Signal vs authority compliance

Not a decision point; no gate, filter or block is added or changed.

## 4b. Judgment-point check

Not applicable.

## 5. Interactions

- **Other ledger calls during a scan.** The listing awaits; routes and other timers can call the ledger in between. Listing reads only the file system and two tables (`session_bindings` for directory membership, `checkpoints` for the changed-file filter). Ingestion, which writes, still runs synchronously in one piece after the listing, exactly as before, and re-reads each file's checkpoint itself, so a list that is slightly stale costs at most a file read that finds nothing new.
- **Close during a scan.** `close()` sets `closed`; every step that touches the database after an await checks it first, and a scan that finds the ledger closed returns an empty report without ingesting.
- **Roots added during a scan** are picked up by the next tick (the scan iterates a copy of the root lists).
- **One scan at a time.** `scanTickAsync()` returns the running scan's promise to a second caller; the server also skips a tick while one runs. The hourly housekeeping counts completed ticks, so it runs every 60 completed ticks: an hour normally, later when scans run past a minute (the backup snapshot is then staler, nothing else).
- **A listing that never ends.** Before, a hung file call froze the server and the supervisor restarted it. Now the server stays up and the ledger alone stops. At the fifth consecutive skipped tick, and every fifth after, the server logs how long the tick has run and records `ingest-tick-stuck` evidence. The evidence row sampled once an hour carries that tick's duration (`tickMs`), and any tick that takes over a minute is logged with its duration.
- **Bindings.** One-shot invocations are flushed at the start of the tick and again after the listing, so a one-shot that finished during the listing has its binding before its transcript is read.
- **The coverage view during a scan** (`listRoots()`) can show this tick's skip and window counts for roots already listed beside the previous tick's pending counts.
- **File workers.** The async walk keeps at most 32 stats queued at a time on Node's file worker pool (4 threads by default; the server does not raise it), shared with every other asynchronous file, DNS-lookup and zlib call in the process. On a quiet disk an unrelated call waits a few milliseconds behind them. On a contended disk all four workers can sit in slow stats, so other asynchronous file work in the server slows for the length of the listing even though the event loop keeps turning. Listing took 1.0 to 5.4 s on the Studio.

## 6. External surfaces

None. No route, message, config or stored-data change. Two new public methods on `UsageLedger`; one new evidence reason (`ingest-tick-stuck`) and one new context field (`tickMs`) on the existing `usage.ledger` feature evidence.

## 7. Multi-machine posture

Machine-local by design and unchanged: each machine scans its own transcript roots; the pool view is built from each machine's own ledger.

## 8. Rollback cost

Revert the commit. Checkpoints and rollups are written by the same code either way.

## Conclusion

Moves tens of thousands of synchronous directory reads and stats per minute off the server's main thread with no change in what is counted. Ship, and continue CMT-1718.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, read-only, given the code and the questions, not the conclusion).

**Round 2: Concur.** All three should-fix items confirmed applied, and no unlisted behaviour change in the extracted tick. It raised one more should-fix (the user-facing sentence in the release note still overclaimed; reworded) and wording nits (how often the duration is recorded; the plain-English "not fixed" paragraph; a stale test count; one more vanishing-file branch to test), all applied.

**Reviewer concurred:** yes (both rounds).

**Round 1: Concur, no blocker.** Parity, races and wiring read clean: the async listers apply the same predicates in the same branches, ingestion re-reads each checkpoint so a stale listing is harmless, and `close()` sets `closed` before closing the database with a check before every database call that follows an await. Three should-fix findings, all applied:

1. The write-up must not claim the tick no longer blocks: only the listing moved. Section 2 now lists what is still synchronous, including the backlog case and the detail rescan.
2. A listing that never ends would have stopped the ledger silently and for good. The tick now reports a run of skipped ticks and records each tick's duration.
3. The server wiring was tested only by matching source text, and the close test exercised one check of six. The tick's rules moved into `usageLedgerTick.ts` with behavioural tests (11), and the close test now closes the ledger at every stage of the listing (confirmed by removing two of the checks: the test fails with "The database connection is not open"). Added: a bound session outside the agent home, a file that vanishes before its stat, empty roots, a Codex file outside the window, a root added during a scan, and the checkpoint cleanup on a closed ledger.

Nits applied: invocations are flushed again after the listing; nothing is recorded for a ledger closed during the tick; the worker-pool queueing, the housekeeping cadence and the mixed coverage view are stated in section 5.

