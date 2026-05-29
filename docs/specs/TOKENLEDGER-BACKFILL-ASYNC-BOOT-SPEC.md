---
title: TokenLedger attribution backfill must not block boot
status: approved
review-convergence: converged
approved: true
approval-basis: >
  Urgent fleet-wide boot-bricking defect. Authorized under the standing
  directive (Justin, 2026-05-29, topic 13435): "anything urgent like this
  should automatically be fixed and deployed." See
  memory feedback_auto_fix_deploy_urgent_fleet_bugs.
eli16-overview: TOKENLEDGER-BACKFILL-ASYNC-BOOT-SPEC.eli16.md
date: 2026-05-29
---

# TokenLedger attribution backfill must not block boot

## Problem (severity: fleet-wide, agent-bricking)

The BurnDetector attribution work (#530) added a one-shot backfill that
rewrites legacy `token_events` rows from the sentinel attribution key
(`unknown::pre-attribution`) to a resolved per-session key. That backfill ran
**synchronously inside the `TokenLedger` constructor**, which is on the server
boot path.

On a large ledger this full-scans the entire `token_events` table at boot. On
Echo's real ledger (202 MB / ~380k rows) the scan burned CPU for 10+ minutes
entirely inside `better_sqlite3` (`sqlite3VdbeExec` / `btreeNext` /
`pcache1Fetch` — a full B-tree walk with per-row record compares). Under any
load that exceeds the supervisor's health-check timeout, so:

1. The supervisor health check times out while the constructor is still
   scanning → the boot is killed mid-scan.
2. Because the scan never finished, the completion marker
   (`ledger_meta['attribution-backfill-v1']`) is never written.
3. The next boot re-runs the same full scan from the start → killed again.
4. **The server can never become healthy. Permanent crash-loop.**

This bricked Echo for ~90 minutes on 2026-05-29. Any agent whose
`token-ledger.db` is large enough that the scan exceeds the health-timeout is
exposed to the same crash-loop the moment its server restarts after #530
shipped. It is high-severity: a feature that shipped today can brick agents on
their next restart, with no in-session recovery path.

## Root cause

A potentially-unbounded table scan was placed on the synchronous boot path. The
amount of work scales with ledger size, but the health-check budget is fixed —
so beyond some ledger size the boot is guaranteed to be killed before the work
completes, and the work has no resumable progress, so it restarts from zero
every boot.

## Design

The backfill must not gate the server becoming healthy, and it must make
forward progress that survives a kill. Three changes:

### 1. Run asynchronously after the server is listening (default)

`TokenLedgerOptions` gains `attributionBackfill?: 'async' | 'sync' | 'off'`,
default `'async'`.

- `'async'` (default, production): the constructor returns immediately. A
  background timer (`setTimeout`, unref'd so it never holds the process open)
  drives the backfill one chunk at a time *after* boot, so `/health` passes
  immediately and the boot can never be killed by the scan.
- `'sync'`: the constructor runs the full drain inline before returning. Used
  by tests that assert post-construction conversion, and available to any
  caller that wants the legacy behavior.
- `'off'`: no automatic backfill. The chunk method is still callable directly
  (used by tests and any future explicit driver).

### 2. Chunk + persist progress (resumable across boots)

`backfillAttributionOnce()` is refactored from a single full scan into a loop
over `backfillAttributionChunk(limit)`. Each chunk:

- Returns early if the completion marker is already set (idempotent — a
  re-opened, already-migrated DB does zero work).
- Selects at most `limit` DISTINCT `(session_id, project_path, model)` triples
  still on the sentinel key, resolves each to a real attribution key, and
  applies the `UPDATE`s in one transaction.
- When no sentinel triples remain (or a chunk makes zero progress), writes the
  completion marker and reports `done: true`.

Because every chunk that converts rows commits its own transaction, progress is
durable. A kill between chunks loses at most one in-flight chunk's worth of
work; the next run resumes from where it stopped instead of restarting the full
scan. The marker value is unchanged (`attribution-backfill-v1`), so an agent
that already completed the backfill under the old synchronous code is detected
as done and never re-scans.

### 3. Bounded failure handling + clean shutdown

- The async driver gives up after `ATTRIBUTION_BACKFILL_MAX_FAILURES`
  consecutive chunk errors (logs and stops rescheduling) so a persistently
  failing chunk cannot spin forever.
- `close()` sets a `closed` flag and clears the pending timer before closing
  the DB, so a scheduled chunk can never run against a closed handle.

## Idempotency & migration parity

- This is server-internal monitoring code, not an agent-installed file
  (`settings.json` / config defaults / CLAUDE.md template / hook scripts /
  skills), so no PostUpdateMigrator entry is required — every agent picks up
  the new boot behavior simply by running the new server build.
- The completion-marker key and value are unchanged, so the change is safe to
  roll forward and backward: an agent mid-backfill under old code, or already
  complete, both behave correctly under the new code.

## Convergence notes (adversarial self-review)

- *Does async leave `/tokens/*` showing the sentinel key briefly?* Yes — for the
  short window between boot and backfill completion, some rows still read
  `unknown::pre-attribution`. This is strictly better than the prior state
  (server fully down) and matches how the sentinel already behaves on a fresh
  install before any backfill. Attribution is observability-only; it never gates
  a job or mutates source.
- *Can the chunk loop spin forever?* No. Each chunk either converts ≥1 triple or
  writes the marker and reports done; a zero-progress chunk writes the marker
  too, so the loop always terminates.
- *Premature marker?* The marker is only written when the SELECT finds no
  sentinel triples (or zero progress is made) — never while convertible rows
  remain.
- *close() race?* Guarded: `closed` flag + cleared timer before `db.close()`.

## Testing (all three tiers)

- **Unit** (`tests/unit/burn-attribution-wiring.test.ts`): async default does
  NOT convert rows during construction (boot never blocks on the scan), and
  driving chunks completes the drain; `backfillAttributionChunk(limit)` is
  bounded by `limit`, resumable across calls, and terminates by writing the
  marker. Existing sync-behavior assertions opt into `attributionBackfill:
  'sync'`.
- **Unit** (`tests/unit/token-ledger.test.ts`): the pre-attribution migration
  test opts into `'sync'` to assert post-construction conversion; column
  migration + idempotency unchanged.
- **Integration** (`tests/integration/tokens-503-regression.test.ts`):
  `/tokens/summary` stays 200 opening an old pre-attribution DB; column present;
  event count + totals correct (unaffected — these assert migration + summary,
  not the data backfill).
