# Side-Effects Review — wire AttributionResolver into ingest + exempt the pre-attribution sentinel

## What changed

Completes **Phase 2** of `docs/specs/token-burn-detection-and-self-heal.md`, which
was specced but never wired. Three source files + their tests:

1. **`src/monitoring/AttributionResolver.ts`** — exports a new
   `PRE_ATTRIBUTION_KEY = 'unknown::pre-attribution'` constant: the sentinel
   meaning "the resolver has never run on this event" (the column default and
   the historical hardcoded ingest value). `resolveAttribution()` itself is
   unchanged and never returns this sentinel.

2. **`src/monitoring/TokenLedger.ts`**
   - `ingestLine()` now calls `resolveAttribution({sessionId, projectPath: cwd,
     prompt: null, model})` instead of hardcoding `'unknown::pre-attribution'`.
     The Claude-CLI JSONL assistant line carries no user prompt, so this is
     cwd/job/hook/session-level attribution; prompt-shape attribution remains a
     separate follow-up (needs user+assistant line correlation at ingest).
   - New `ledger_meta` key/value table + `getMeta`/`setMeta` helpers.
   - New `backfillAttributionOnce()` — one-shot, idempotent, marker-guarded
     (`attribution-backfill-v1`) re-resolution of legacy sentinel rows, run
     non-fatally from the constructor after `prepareStatements()`.

3. **`src/monitoring/BurnDetector.ts`** — `tick()` exempts the
   `PRE_ATTRIBUTION_KEY` sentinel from the **absolute-share** trigger only. A
   bucket at 100% under the sentinel is a coverage gap, not a burn. The
   genuinely-residual `unknown::<sessionId>` key (resolver ran, no match) is
   NOT exempt and still alerts (the spec's "alert on unattributable spend").
   Baseline-divergence is unaffected.

## Why

The recurring `unknown::pre-attribution consumed 100.0% of 24h spend
(threshold 25%)` alert was a **fleet-wide false positive**. Because the
resolver was never wired, every JSONL-sourced event defaulted to the single
sentinel bucket, whose share was always 100%, so the absolute-share trigger
fired every hour forever — on every agent with burn-detection enabled (default)
and any daily spend. Real spend on the reporting agent was ~1.5M tokens/24h
(the bleed this system targets was ~3B/day).

## Behavioral side effects

- **BurnDetector no longer emits absolute-share on the sentinel.** Intended.
  This is the false-positive fix. Real burns are unaffected: (a) any resolved
  key (component/job/hook/`unknown::<sid>`) still trips at >25%; (b) the
  sentinel only exists transiently until backfill clears it; (c) a real burner
  sharing the 24h window with sentinel rows still trips (the sentinel is
  skipped, not counted against the burner's share — verified by test
  "does not let the sentinel mask a real burner sharing the window").
- **Existing attribution distribution changes shape.** Instead of one 100%
  bucket, spend now splits per origin (mostly `unknown::<sessionId>` for the
  dominant Claude-CLI path, plus `user-job:*` / `user-hook:*`). The
  `/tokens/*` summary/sessions/by-project routes are unchanged in schema; only
  the `byAttributionKey` grouping is now meaningful. No route signature changed.
- **One-time backfill UPDATE on first boot after upgrade.** On the reporting
  agent that's ~384k rows across a few hundred distinct (session, project,
  model) triples — resolved once per triple inside a single transaction, so a
  handful of bulk UPDATEs, not 384k. Marker-guarded → runs exactly once per DB.
  Wrapped in try/catch in the constructor: a backfill failure logs and is
  swallowed (worst case: sentinel rows stay unattributed and thus exempt from
  burn alerts — i.e. degrades to the old-but-safe behavior, never a crash).

## Migration parity

No `PostUpdateMigrator` change required. The backfill self-heals on the
constructor's next run, which happens on every server start. Existing agents
get it on their next restart onto a version carrying this change. The new
`ledger_meta` table is created idempotently in the SCHEMA list alongside the
existing tables.

## Blast radius / isolation

- Scope is the three monitoring files. **No HTTP route, server-boot, or
  CapabilityIndex change** → no agent-awareness/CLAUDE.md-template update owed.
- Codex token sessions live in a separate table (`codex_token_sessions`) and
  are untouched — burn detection reads only `token_events`.
- Read-only-observability invariant of the TokenLedger is preserved: the only
  new write is to the ledger's own SQLite DB (the backfill UPDATE + the meta
  marker). No source JSONL file is touched.

## Rollback

Revert the three `src/monitoring/*` files. Backfilled `attribution_key` values
are harmless if the revert lands (they're just better labels); the
`ledger_meta` table and its marker row are inert without the new code. No data
loss, no schema-incompatible state. (Per-phase revert matches the umbrella
spec's rollback model.)

## Tests

- New `tests/unit/burn-attribution-wiring.test.ts` (11 tests): resolver never
  returns the sentinel; ingest now resolves a real key; two sessions split into
  two keys; job-cwd → `user-job:*`; backfill converts legacy sentinel rows on
  reopen + is idempotent; BurnDetector regression — sentinel at 100% emits
  nothing, residual `unknown::<sid>` at 100% still emits, sentinel doesn't mask
  a co-occurring real burner.
- Updated `tests/unit/token-ledger.test.ts` (#512 schema-order migration test):
  now asserts the migrated legacy row is backfilled to `unknown::sess-old` and
  the sentinel is gone, instead of asserting the sentinel persists.
- Full sweep green: `vitest run` over burn-detection-phase-1..6 + token-ledger +
  TokenLedger-codex + TokenLedgerPoller-codex + burn-attribution-wiring =
  **149 passed, 0 failed**. `tsc --noEmit` clean.
