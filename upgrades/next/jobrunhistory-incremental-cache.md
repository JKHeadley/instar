<!-- bump: patch -->

# Job-run history no longer freezes the event loop re-reading a 13MB file every minute

## What Changed

`JobRunHistory.readLines()` did a synchronous `readFileSync` + per-line `JSON.parse` of the entire
`.instar/ledger/job-runs.jsonl` (~13MB) on EVERY call — on the hot path of `findRun` /
`recordCompletion` / `recordHandoff` / `query` / `stats` (every job completion/spawn, ~60s cadence).
A live `/usr/bin/sample` caught the event loop frozen 13–16s in `ReadFileUtf8 → ParseJson →
WriteFileUtf8`, misreported by SleepWakeDetector as a ~15s "wake". This is the THIRD distinct
event-loop blocker behind the dashboard "disconnected" flapping (after sync tmux and sync keychain
reads). The read path now uses an incremental in-memory cache keyed on `(size, mtimeMs)`: unchanged
file → cache hit (zero IO); append → tail-read only (O(delta)); shrink/compaction → one full re-read.

## What to Tell Your User

If your dashboard kept dropping its connection even after the tmux and keychain fixes, this was the
remaining cause: a 13MB job-history file re-read whole, every minute, on the server's main thread.
After this update that freeze is gone. (A separate cleanup — capping that file's unbounded growth —
is tracked separately.)

## Summary of New Capabilities

- Incremental `(size, mtimeMs)`-keyed in-memory cache in `JobRunHistory`; unchanged file = zero-IO
  cache hit, append = tail-read only, compaction = one full re-read. Existing semantics (append-only,
  dedup-last-wins, torn-line skip, corrupt-file recovery) preserved exactly.
- Removes the third event-loop blocker behind the dashboard flapping + the associated SleepWakeDetector
  false-wakes.

## Evidence

Root cause diagnosed by a live `/usr/bin/sample` (main thread in ReadFileUtf8 → ParseJson →
WriteFileUtf8) + an mtime-watch catching the 13MB rewrite, correlated with 15–20s freezes every
~20–60s. Fix covered by 4 new regression tests (cache-hit does zero full-file reads across 75 ops;
external append via tail-read; torn-line skip; full re-read on shrink) on top of 30 existing; full
scheduler suite green (346 tests total); tsc clean; no-silent-fallbacks + bounded-accumulation +
no-wholefile-sync-read lints green.
