# Side-effects review — TokenLedger rowid-addressed backfill chunk

**Spec:** `docs/specs/TOKENLEDGER-BACKFILL-ROWID-SPEC.md`
**Change:** `src/monitoring/TokenLedger.ts` (+ unit test)
**Class:** performance fix — eliminates per-chunk event-loop blocking in the
one-shot attribution backfill (completes the #534 boot-fix work).

## What changed

`backfillAttributionChunk(limit)` rewritten from DISTINCT-triple-scoped to
ROW-scoped:

- Was: `SELECT DISTINCT session_id, project_path, model ... LIMIT limit` then one
  `UPDATE ... WHERE attribution_key = sentinel AND session/project/model = ...`
  per triple (each UPDATE O(sentinel_size)).
- Now: `SELECT rowid, session_id, project_path, model ... LIMIT limit` then one
  `UPDATE ... WHERE rowid = ?` per row (O(1) per row).

`ATTRIBUTION_BACKFILL_CHUNK` raised 100 → 2000 (now ROWS, not triples).

## Blast radius

- **`backfillAttributionOnce()` / async driver**: unchanged signatures and
  return shapes (`{ backfilled, done }`, `{ backfilled, alreadyDone }`). Same
  marker key/value (`attribution-backfill-v1`) → already-complete agents never
  re-run; interrupted agents resume.
- **End state**: identical — every sentinel row receives the same resolved key it
  would have under the old triple-batched code (resolver is a pure function of
  the triple).
- **`limit` semantics**: changes from "distinct triples" to "rows". Only callers
  are the async driver, `backfillAttributionOnce`, and tests. Tests that pass an
  explicit `limit` with 1 row per triple are unaffected (rows == triples there).
- **Public API / schema / config**: none changed.

## What could break (and why it doesn't)

- **A caller relying on `backfilled` meaning "triples"?** None exists — it always
  meant "rows changed" (`res.changes`), and still does.
- **Index dependency**: the SELECT uses the existing `(attribution_key, ts)`
  index to reach the sentinel partition; no new index required.
- **Long burst from a big `limit`?** 2000 rows = ~5ms (measured on a 202MB
  ledger); far under any health-timeout. `limit` is the only tunable.

## Security

No new external input, network, auth, or filesystem surface. Pure change to an
internal SQLite maintenance query.

## Migration parity

Server-internal monitoring code, not an agent-installed file — no
PostUpdateMigrator entry required.

## Rollback

Revert the commit. Marker key/value unchanged; a rolled-back agent mid-drain or
complete is consistent under the prior code.

## Tests

Unit (`burn-attribution-wiring`, `token-ledger`) + integration
(`tokens-503-regression`) — 38 green; `tsc --noEmit` clean. New row-granular
regression test (bounds by rows; multi-row triple collapses to one key).
Manual at-scale run on the real 202MB / 389,621-row ledger: full drain 14s,
0 sentinel rows after.
