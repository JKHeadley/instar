# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Fixes a second cause of a permanently-unavailable token ledger: a schema-migration ordering bug.**

`TokenLedger`'s `SCHEMA` setup ran `CREATE INDEX idx_token_events_key_ts ON token_events(attribution_key, ts)` BEFORE the `ALTER TABLE token_events ADD COLUMN attribution_key` migration. On any agent whose `token_events` table was created before the `attribution_key` column existed, `CREATE TABLE IF NOT EXISTS` no-ops (the column is never added), the index then throws `no such column: attribution_key`, and the init loop only swallows `duplicate column name` — so the error rethrows, TokenLedger init fails, and `/tokens/summary`, `/tokens/by-project`, `/tokens/sessions`, `/tokens/orphans` all return 503 (`token ledger unavailable`) forever.

This was found while verifying the heal fix shipped in 1.3.77 (#509): Echo's own `/tokens/summary` was still 503, but with `SqliteError: no such column: attribution_key` rather than the ABI mismatch #509 addressed — a distinct, fleet-wide cause affecting every agent with a pre-`attribution_key` ledger DB.

The fix reorders the `SCHEMA` array so the `ALTER … ADD COLUMN attribution_key` migration runs immediately after `CREATE TABLE token_events` and before any index/query that references the column. Fresh DBs are unaffected (the column is created with the table; the relocated ALTER throws duplicate-column → swallowed). Pre-attribution DBs get the column added, then the index and the `attribution_key` queries succeed. A code comment records the invariant: a column-adding migration must precede anything that references the column.

## What to Tell Your User

If your agent's token usage tab or token endpoints have been showing as unavailable, this likely fixes it. The token ledger is built on a small local database, and a recent version added a new column to it. On agents whose database was created before that column existed, the setup steps ran in the wrong order — it tried to build an index that uses the new column before the step that adds the column to older databases, so the whole setup gave up and the ledger stayed off. The fix simply runs those setup steps in the right order, so older databases get upgraded cleanly. Nothing for you to do; the token data comes back the next time the agent restarts onto this version. Brand-new agents were never affected.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Pre-existing token-ledger DBs self-migrate | Automatic. The `attribution_key` column migration now runs before the index that depends on it, so agents with an older token-ledger database recover their `/tokens/*` endpoints on restart instead of staying at 503. No config. |

## Evidence

- Unit: `tests/unit/token-ledger.test.ts` — new regression block builds a `token_events` table with the OLD schema (no `attribution_key`) plus a pre-existing row, then constructs `TokenLedger`: it does NOT throw, `PRAGMA table_info` shows the migrated column, `summary()` + `byAttributionKey()` work, the pre-existing row is backfilled with the `'unknown::pre-attribution'` DEFAULT, and re-initialising is idempotent. All 19 pre-existing TokenLedger tests still pass (fresh-DB path unchanged).
- Live: Echo's on-disk `token_events` table verified to lack `attribution_key`; its `/tokens/summary` returned 503 with `SqliteError: no such column: attribution_key` at TokenLedger init — the exact failure this reorder removes.

Spec: `docs/specs/token-ledger-native-heal.md` (2026-05-29 Amendment 2 — in-scope, finishes AC#7).
