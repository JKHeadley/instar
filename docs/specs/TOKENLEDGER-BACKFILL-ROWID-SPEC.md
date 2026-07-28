---
title: TokenLedger attribution backfill — rowid-addressed chunks (no event-loop blocking)
status: approved
review-convergence: converged
approved: true
approval-basis: >
  Completes the boot-fix performance work. The async/chunked backfill shipped in
  #534 stopped the backfill from blocking server BOOT, but each 100-triple chunk
  still ran ~23s of synchronous SQLite (measured on Echo's real 202MB ledger)
  because each per-triple UPDATE re-scanned the whole sentinel partition — a
  post-boot event-loop-blocking burst on large-live-ledger agents. This makes
  each chunk O(rows) instead of O(triples × sentinel_size). Verified at scale on
  the real 202MB / 389,621-row ledger (full drain 14s total, ~72ms per async
  chunk, 0 sentinel rows after). Self-approved under the standing
  complete-delivery directive (Justin, topic 13435) as a low-risk, end-state-
  identical performance fix; flagged to Justin for review.
eli16-overview: TOKENLEDGER-BACKFILL-ROWID-SPEC.eli16.md
date: 2026-05-29
---

# TokenLedger attribution backfill — rowid-addressed chunks

## Problem

The one-shot attribution backfill (`backfillAttributionChunk`) processed up to
`limit` DISTINCT `(session_id, project_path, model)` triples per chunk, running
one `UPDATE token_events SET attribution_key = ? WHERE attribution_key =
<sentinel> AND session_id = ? AND project_path IS ? AND model IS ?` per triple.

Each such UPDATE uses the `(attribution_key, ts)` index to reach the sentinel
partition, then filters by session/project/model — so it touches the WHOLE
sentinel partition. With 100 triples per chunk that is O(100 × sentinel_size).
On Echo's real ledger (202MB, 389,621 sentinel rows) each 100-triple chunk took
**~23 seconds** of synchronous `better_sqlite3` work.

The #534 fix moved this off the BOOT path (so it no longer bricks startup), but a
23s synchronous chunk still blocks the Node event loop in a burst whenever it
runs. On an agent whose LIVE ledger is large and sentinel-heavy, the background
drain would freeze health checks / request handling for ~23s at a time until the
one-time drain completed.

## Design

Make each chunk O(rows), independent of ledger size:

- Select up to `limit` individual still-sentinel ROWS, addressed by `rowid`:
  `SELECT rowid, session_id, project_path, model FROM token_events WHERE
  attribution_key = <sentinel> LIMIT @limit`.
- Resolve each row's key (same `resolveAttribution`) and update it by its integer
  primary key: `UPDATE token_events SET attribution_key = ? WHERE rowid = ?` — an
  O(1) point update.
- `limit` now bounds ROWS, not distinct triples. The chunk constant is raised to
  2000 rows (each chunk ~5–72ms even on a 202MB ledger).

Two rows of the same triple resolve to the same key, so the END STATE is
identical to the old triple-batched approach — only the work-per-chunk and its
shape change. Termination is unchanged: an empty SELECT (or a batch that moves
nothing off the sentinel — the documented acceptable worst case) sets the
completion marker and reports `done`. The marker key/value is unchanged, so an
agent that already completed the backfill never re-runs, and one interrupted
mid-drain resumes from the remaining sentinel rows.

## Convergence notes (adversarial self-review)

- *Same end state?* Yes — `resolveAttribution` is a pure function of
  (session, project, model); per-row resolution yields the same key for every
  row of a triple. Unit test asserts all rows of a multi-row triple collapse to
  one key with the correct `eventCount`.
- *Termination?* `resolveAttribution` never returns the sentinel, so every
  selected row converts → progress every chunk → SELECT eventually returns 0 →
  marker set. The "no progress → finalize" guard remains as defense.
- *Could a huge `limit` reintroduce a long burst?* The constant (2000) is chosen
  so each chunk is well under any health-timeout; the value is the only tunable.
- *Index dependency?* The SELECT relies on the existing `(attribution_key, ts)`
  index to reach the sentinel partition cheaply; that index already exists.

## Testing

- **Unit** (`tests/unit/burn-attribution-wiring.test.ts`): new test proves the
  chunk bounds by ROWS not triples (a single triple with 5 rows converts 2 at
  `limit=2`, not all 5 — which the old DISTINCT-triple design would have done),
  drains fully, and all 5 rows collapse to one resolved key with `eventCount` 5.
  Existing chunk/async/idempotency tests still pass (their seed is 1 row per
  triple, so rows == triples).
- **At-scale (manual, on the real artifact)**: drove the rowid backfill over a
  copy of Echo's real 202MB / 389,621-sentinel-row ledger — full drain 14s total
  (vs the old design's ~23s for a single 100-triple chunk), ~5ms per 1000 rows,
  0 sentinel rows remaining.

## Migration parity

Server-internal monitoring code, not an agent-installed file — no
PostUpdateMigrator entry required. Marker key/value unchanged.
