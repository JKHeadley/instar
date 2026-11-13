# The usage ledger lists transcript files off the server's main thread

<!-- bump: patch -->

## What Changed

`UsageLedger.scanTick()` runs from a 60-second timer in the server. Before it ingests anything it lists every Claude transcript and Codex rollout under every registered root: one `readdirSync` per directory, one `statSync` per file, and a second `statSync` per in-window file. On a development machine with 12 Claude config homes and 6 Codex homes that is about 4,000 directories and 50,000 files, synchronously, every minute.

The server timer now calls `scanTickAsync()`: the same walk under the same rules with every directory read and stat through `fs.promises`. Only the listing moved: ingestion of the changed files is unchanged (synchronous, up to `filesPerTick` files a tick), as are the one-off detail rescan after a snapshot import and the hourly prune and snapshot. One tick runs at a time (`createUsageLedgerTick`, `src/monitoring/usageLedgerTick.ts`); a tick that finds the previous one still listing is skipped, and at the fifth skipped tick in a row the server logs it and records `ingest-tick-stuck` evidence. The hourly sampled tick evidence now carries that tick's duration (`tickMs`), and a tick that takes over a minute is logged. The hourly `dropMissingCheckpoints()` existence checks moved to `dropMissingCheckpointsAsync()` the same way.

`scanTick()` and `dropMissingCheckpoints()` remain for synchronous callers and share the non-listing code with the new path.

## What to Tell Your User

Nothing changes that you will see. The agent's server now looks through its saved conversation files in the background. That file-listing step, which got the server restarted on a very busy disk on 13 November, no longer holds the server up.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Usage scan listing off the main thread | Automatic |

## Evidence

Studio, 2026-11-13 02:36:38 PST, `logs/server-freeze/freeze-20261113T103638Z.txt`: three failed health checks; a 5-second native sample of the server's main thread shows all 3,904 samples inside one timer callback, under `Array.map`, in `fs.readdirSync` (`open`, `getdirentries64`). The supervisor log: "Server process alive but unresponsive for 7 checks (~70s) — restarting". A 150-second caller-attributed CPU profile of the live server minutes later puts the largest synchronous `readdir` and `stat` share under `scanTick <- listRootFiles <- walk` and `dirMayHoldMembers` in `UsageLedger`.

Measured with the built code on the Studio's real roots (12 Claude, 6 Codex; both versions list the same 34,059 pending files into an empty ledger): synchronous tick, worst event-loop gap 1,948 ms and 722 ms (two rounds); `scanTickAsync()`, 23 ms and 20 ms. Total listing time for the async walk was 5.4 s cold and 1.0 s warm, spread across the loop.

Tests: `tests/unit/UsageLedger.asyncScan.test.ts` (12: identical report, totals, statuses and coverage to the synchronous tick over a tree with three roots, a subagent file, a session ruled in by a spawn record, non-member directories, a too-deep file, a symlink, out-of-window files and Codex rollouts; identical under a small file budget across three ticks; no `readdirSync` or `statSync` call during the async tick, with a control showing the synchronous tick makes both; timers fire during the listing; one scan at a time; a ledger closed at every stage of the listing ends quietly; a file that vanishes before its stat; a root added mid-scan; checkpoint cleanup parity and on a closed ledger; the server wiring), `tests/unit/usageLedgerTick.test.ts` (11: one tick at a time, never rejecting even when a reporting callback throws, a stuck listing reported at the fifth skip, a failed tick or failed housekeeping frees the slot, housekeeping order and cadence on completed ticks only, nothing done for a ledger closed or replaced mid-tick). Existing ledger tests unchanged and passing (59).
