# Side-effects review — TokenLedger async/chunked attribution backfill

**Spec:** `docs/specs/TOKENLEDGER-BACKFILL-ASYNC-BOOT-SPEC.md`
**Change:** `src/monitoring/TokenLedger.ts` (+ test updates)
**Class:** boot-path safety fix for a fleet-wide, agent-bricking crash-loop.

## What changed

The one-shot attribution backfill (#530) no longer runs synchronously inside the
`TokenLedger` constructor. New `attributionBackfill: 'async' | 'sync' | 'off'`
option (default `'async'`):

- `'async'` — constructor returns immediately; a background unref'd timer drains
  the backfill one bounded chunk at a time after the server is listening.
- `'sync'` — legacy inline full-drain at construction (tests + opt-in callers).
- `'off'` — no auto-run; `backfillAttributionChunk()` callable directly.

`backfillAttributionOnce()` refactored to loop over a new
`backfillAttributionChunk(limit)` (DISTINCT-triple, transactional, marker-gated,
resumable). `close()` now clears the pending timer and sets a `closed` guard.

## Blast radius

- **Callers of `new TokenLedger(...)`:** the production caller (server startup
  wiring) gets the new default `'async'` with no code change. No call sites need
  to pass the new option. Searched: the only behavioral consumers are the server
  boot wiring and tests.
- **Public API:** purely additive — one optional constructor field, one new
  public method (`backfillAttributionChunk`). No signature of an existing method
  changed. `backfillAttributionOnce()` keeps its return shape
  (`{ backfilled, alreadyDone }`).
- **DB schema:** unchanged. Same `ledger_meta` marker key AND value
  (`attribution-backfill-v1`) → an agent that already completed the backfill
  under old code is detected as done and never re-scans; an agent mid-scan
  resumes rather than restarting.

## What could break (and why it doesn't)

- **Tests asserting synchronous post-construction conversion** — would now see
  un-converted rows under the new default. Mitigated: the two such tests
  (`token-ledger.test.ts` migration test, `burn-attribution-wiring.test.ts`
  backfill block) opt into `attributionBackfill: 'sync'`. Verified green.
- **`/tokens/*` correctness window** — for a short interval after a large-ledger
  boot, some rows still read the `unknown::pre-attribution` sentinel until the
  background drain catches up. Attribution is observability-only (never gates a
  job, never mutates source), and a fresh install already serves the sentinel
  before its first backfill — so this is an existing, benign state, not a new
  failure mode. Strictly better than the prior outcome (server fully down).
- **Runaway background loop** — bounded by `ATTRIBUTION_BACKFILL_MAX_FAILURES`
  consecutive-error cap and by the marker-on-zero-progress termination; the
  timer is unref'd so it never holds the process open.
- **Use-after-close** — `close()` sets `closed` + clears the timer before
  `db.close()`; a scheduled chunk checks `closed` and no-ops.

## Security

No new external input, network, auth, or filesystem surface. No secrets touched.
Pure refactor of an internal SQLite maintenance task from sync→async-chunked.

## Migration parity

Server-internal monitoring code, not an agent-installed file — no
PostUpdateMigrator entry required. Every agent receives the fix by running the
new server build. No config defaults added.

## Rollback

Revert the commit. The marker key/value is unchanged, so a rolled-back agent
that had started (or finished) the async backfill is consistent under the old
synchronous code path.

## Tests

Unit (`burn-attribution-wiring`, `token-ledger`) + integration
(`tokens-503-regression`) — 52 tests green. `tsc --noEmit` clean.
