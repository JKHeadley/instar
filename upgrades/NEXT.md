# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Token-ledger attribution backfill is now fast and never blocks the event
loop.** The one-time backfill that re-labels legacy "unknown" token rows used to
work one distinct (session, project, model) group at a time, and each group's
UPDATE re-scanned the whole unknown-row partition — on a very large ledger
(Echo's real one: 202 MB / ~390k unknown rows) that was ~23 seconds of
synchronous database work per batch. The boot fix had already moved this off the
startup path (so it couldn't brick boot), but a 23s batch could still freeze a
large-ledger agent's health checks while it ran in the background.

The backfill now works row-by-row, updating each row by its internal id (an
instant point update) instead of re-scanning per group. Same end result (every
row gets the same label it would have before), but each batch is ~5 ms per 1,000
rows instead of 23 s — so the background re-labeling never freezes the agent.
Measured on the real 202 MB ledger: all ~390k rows re-labeled in ~14 s total, in
tiny non-blocking steps.

## What to Tell Your User

Nothing to configure. If you run an agent with a very large token-usage history,
its one-time usage re-labeling now runs quietly in the background without any
freezes. Most agents won't notice anything — this completes the performance
story of the recent token-ledger boot fix.

## Summary of New Capabilities

- Attribution backfill processes rows in `rowid`-addressed batches (O(1) per
  row) instead of per-distinct-triple full scans — no event-loop-blocking bursts
  on large ledgers.
- `ATTRIBUTION_BACKFILL_CHUNK` now bounds rows per chunk (2000), tuned so each
  chunk stays well under any health-check timeout.

## Evidence

- `tests/unit/burn-attribution-wiring.test.ts` — new test: the chunk bounds by
  ROWS not distinct triples (a single triple with 5 rows converts 2 at limit=2,
  not all 5), drains fully, and all 5 rows collapse to one resolved key with
  eventCount 5. Existing chunk/async/idempotency tests still pass.
- Manual at-scale run on a copy of Echo's real 202 MB / 389,621-sentinel-row
  ledger: full drain 14 s total (vs the old design's ~23 s for a single
  100-triple chunk), ~5 ms per 1,000 rows, 0 sentinel rows remaining.
- Side-effects: `upgrades/side-effects/tokenledger-backfill-rowid.md`.
