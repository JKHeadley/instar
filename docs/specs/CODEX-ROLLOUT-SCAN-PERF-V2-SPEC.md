---
title: Stat only the newest-created candidates in listAllRollouts so /codex/usage survives a CPU-starved event loop
review-convergence: retrospective-single-pass
approved: true
eli16-overview: CODEX-ROLLOUT-SCAN-PERF-V2.eli16.md
---

# Codex Rollout Scan — stat only the newest-created candidates

## Problem

The first perf fix (CODEX-ROLLOUT-SCAN-PERF, v1.3.124) narrowed `listAllRollouts`
from statting the WHOLE `$CODEX_HOME/sessions` tree to statting only the newest
date-partitions. But it still `await fs.stat`-ed EVERY file in those partitions —
on the real machine that is the two newest days = ~3,637 files. In a healthy
process that is ~57 ms. **But when the server's event loop is CPU-starved it is
not.** Force-deploying 1.3.124 to Echo, `GET /codex/usage` STILL timed out
(curl `000` after 25 s) while `/tokens/summary` and `/capabilities` returned in
< 0.4 s. The server log showed the cause:

```
[SleepWakeDetector] Drift ~14s under load ratio 1.72 (> 1.5) — CPU starvation
```

Under a ~14 s event-loop drift, the 3,637 sequential `await fs.stat` calls each
wait for a starved loop turn → the route hangs for tens of seconds. The
fast routes do only a handful of awaits, so they are unaffected. (The underlying
CPU load is a separate, broader issue; this makes the route robust regardless.)

## Fix

Eliminate the per-file `stat` storm. Find the newest rollouts WITHOUT statting
every file:

1. Enumerate date-partition dirs newest-first; `readdir` (one syscall per dir,
   no per-file stat) the newest partitions to collect candidate PATHS until
   there are >= `limit * STAT_OVERSCAN` (STAT_OVERSCAN = 4) AND >=
   `MIN_PARTITIONS_SCANNED` (2) non-empty partitions are covered.
2. Sort candidates DESCENDING by path — the zero-padded `YYYY/MM/DD` dir +
   `rollout-<ISO-ish-ts>` filename make a lexicographic sort chronological by
   CREATION time, no stat needed.
3. `stat` ONLY the top `limit * STAT_OVERSCAN` candidates for the authoritative
   mtime; sort by mtime; return the newest `limit`.

A `limit`-8 call now does **~32 stats instead of ~3,637**. `readdir` of a large
partition is one cheap syscall returning all names; the in-memory sort of a few
thousand path strings is sub-millisecond. The non-date-partitioned fallback is
unchanged.

## Trade-off (documented)

"Newest by mtime" becomes "newest by mtime among the newest-CREATED candidates."
The `STAT_OVERSCAN = 4` window means a long-running session (older filename,
newer mtime) is still caught as long as it is among the newest `limit*4` created.
For the rate-limit reader this is exact — the account-wide windows are identical
across any recently-active session. For the resume/token-ledger callers the only
miss is a session created older than the newest `limit*4` yet still the single
most-recently-touched file — vanishingly rare.

## Signal vs authority

No decision surface — a read-path performance optimization of a helper that
returns data. It gates/blocks/decides nothing.

## Testing

- **Unit** (`codexListAllRolloutsPerf.test.ts`, updated): newest-first across
  partitions; >= 2-partition coverage; the `fs.stat` spy now asserts the bounded
  candidate-stat count (well under the file total); non-date-partitioned
  fallback; empty when no sessions dir.
- **Regression**: reader / TokenLedger / resume / canary suites green.
- **Verified on real data**: against the live 14,277-file / 1.4 GB tree, a
  `limit`-8 call does **32 stats in 14 ms** (was ~3,637 stats), returning the
  same newest rollout.

## Rollback

Revert the `listAllRollouts` body to the v1 (stat-every-file-in-newest-partitions)
form. No data, no migration.

## Authority note

Shipped under the 12-hour session deploy mandate — found by force-deploying the
v1 fix (1.3.124) to Echo and observing `/codex/usage` STILL timing out, then
reading the server log to find the CPU-starvation interaction. `approved:true`
self-applied; flagged in the PR.
