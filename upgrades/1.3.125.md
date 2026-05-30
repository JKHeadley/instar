# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Fixed `GET /codex/usage` still timing out on a large codex history under server
load — by not statting thousands of files.** The previous fix (v1.3.124) narrowed
`listAllRollouts` to the newest date-partitions, but it still `await fs.stat`-ed
every file in them — ~3,637 on a real account. That is fast in a healthy process,
but when the server's event loop is CPU-starved (the log showed a ~14 s drift),
those thousands of sequential awaited stats each wait for a starved loop turn and
the route hangs for tens of seconds. (Other endpoints were fine — they do only a
handful of awaits.) `listAllRollouts` now finds the newest rollouts WITHOUT the
stat storm: it `readdir`s the newest partitions to collect candidate paths (one
syscall per dir, no per-file stat), sorts them by the creation timestamp embedded
in the filename, and `stat`s ONLY the newest `limit * 4` candidates (~32 for the
usage reader) for the authoritative mtime. The returned newest-N is unchanged.
This fixes all four callers of the helper at once.

## Summary of New Capabilities

- No new capability — a performance fix. `listAllRollouts` now does ~32 file
  stats instead of ~3,637 on a large account, so codex usage/ledger/resume reads
  stay fast even when the server is under heavy load.

## What to Tell Your User

The codex usage check now answers instantly even on a heavy account AND when the
machine is under heavy load. The earlier fix already stopped it from reading the
whole history, but it still checked the timestamp of every recent log file — a
few thousand of them — one at a time, which stalled when the server was
overloaded. It now reads just the list of recent filenames, picks out the newest
by the time in the name, and only checks the real timestamps of the few most
recent. Nothing else changes.

## Evidence

**Reproduction.** After deploying the first fix (v1.3.124) to a server with a
14,277-file codex history, `GET /codex/usage` STILL returned a connection timeout
(curl status 000 after 25 s) while `/tokens/summary` (0.19 s) and `/capabilities`
(0.38 s) on the same server were fast. The server log showed the cause:
`[SleepWakeDetector] Drift ~14s under load ratio 1.72 — CPU starvation`. The
reader ran in 57 ms in an isolated process and 250 ms for 5 concurrent calls — so
the slowness was not the reader's logic but its ~3,637 sequential `await fs.stat`
calls colliding with a starved event loop (each stat callback waits for a loop
turn).

**Before / after.** Old: ~3,637 stats per call. New: against the same live
14,277-file / 1.4 GB tree, a `limit`-8 call does **32 stats in 14 ms**, returning
the same newest rollout. A unit test (`fs.stat` spy) asserts the bounded stat
count for a 206-file / 42-partition fixture; the reader / TokenLedger / resume /
canary suites stay green.
