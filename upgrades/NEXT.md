# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Fixed a fleet-wide crash-loop that could brick an agent on startup.** The
TokenLedger attribution backfill (shipped in #530) ran a full scan of the entire
token-usage database synchronously during server boot. On a large ledger (Echo's
real one: 202 MB / ~380k rows) that scan ran 10+ minutes — longer than the
supervisor's health-check timeout — so the boot was killed mid-scan, the
"done" marker was never written, and the next boot re-ran the same scan from
scratch. The result was a permanent boot crash-loop: the server could never
become healthy.

The backfill now runs **asynchronously after the server is listening**, in small
**resumable chunks** that save progress — so a large token-usage database can no
longer freeze an agent on startup. Boot is instant again regardless of ledger
size; the re-labeling drains quietly in the background. The completion marker is
unchanged, so agents that already finished the backfill never re-run it, and
agents interrupted mid-scan resume instead of restarting.

## What to Tell Your User

If your agent ever got stuck "restarting" or unresponsive after a recent update,
this removes one cause: a large token-usage database freezing the agent on
startup. No action needed — boot is now instant regardless of ledger size. For a
few seconds after a big agent boots, a handful of token-usage rows may show an
"unknown" label until the background pass catches up — harmless, since token
counts are display-only and never block real work.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Non-blocking token-ledger backfill | Automatic — every agent gets it by running the new build. No config needed. |
| `attributionBackfill` ledger option | `'async'` (default), `'sync'`, or `'off'` on `new TokenLedger(...)` — opt into inline backfill or disable auto-run (tests / special cases). |

## Evidence

**Reproduction:** Echo's production server, 2026-05-29 ~18:34–19:53Z. After a
restart, `/health` returned 000 for ~90 minutes; the supervisor log showed
repeated "Server unhealthy. Restart attempt N/5". `sample <server-pid> 3`
captured the booting process burning CPU entirely inside `better_sqlite3.node`
(`sqlite3VdbeExec` / `btreeNext` / `pcache1Fetch` — a full B-tree scan). The DB:
`.instar/server-data/token-ledger.db` = 202 MB / ~380k rows.

**Before:** server stuck in a permanent boot crash-loop; the synchronous
constructor backfill never finished before the health-timeout killed the boot,
so the completion marker was never set and every subsequent boot re-scanned from
zero.

**After:** with the async/chunked backfill, the constructor returns immediately
and the server reports healthy at once; the re-labeling drains in the
background. Confirmed manually that moving the oversized DB aside let a fresh
(empty) ledger boot instantly — isolating the backfill as the sole cause — and
the new code reproduces that instant boot while preserving the full ledger.
Unit + integration tests cover async-non-blocking, chunk-bounded/resumable, and
the existing migration/503 paths (52 green); `tsc --noEmit` clean.
