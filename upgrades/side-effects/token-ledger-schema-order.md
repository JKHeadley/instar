# Side-Effects Review — TokenLedger schema migration ordering

**Version / slug:** `token-ledger-schema-order`
**Date:** `2026-05-29`
**Author:** Echo (instar developer agent)
**Spec:** `docs/specs/token-ledger-native-heal.md` (2026-05-29 Amendment 2 — in-scope, finishes AC#7)
**Second-pass reviewer:** required (touches a shared SQLite init path on every agent)

## Summary of the change

`TokenLedger`'s `SCHEMA` DDL array ran `CREATE INDEX idx_token_events_key_ts ON token_events(attribution_key, ts)` BEFORE the `ALTER TABLE token_events ADD COLUMN attribution_key` migration. On any agent whose `token_events` table predates `attribution_key`, `CREATE TABLE IF NOT EXISTS` no-ops (column not added), the index then throws `no such column: attribution_key`, and the init loop only swallows `duplicate column name` → the error rethrows → TokenLedger init fails → `/tokens/*` return 503 permanently. Verified live: Echo's `token_events` table on disk lacks the column.

Fix: reorder `SCHEMA` so the `ALTER … ADD COLUMN attribution_key` runs immediately after `CREATE TABLE token_events` and before any index/query referencing the column. Pure reorder; no logic change. Code comment establishes the invariant: a column-adding migration MUST precede any index/query that references the new column.

Files touched:
- `src/monitoring/TokenLedger.ts` — move the `attribution_key` ALTER up within the `SCHEMA` array (before `idx_token_events_key_ts`); comments updated.
- `tests/unit/token-ledger.test.ts` — new regression block: a pre-attribution DB migrates on init (no 503), the column is added, `summary()`/`byAttributionKey()` work, the pre-existing row is backfilled with the DEFAULT, and re-init is idempotent.

Decision-point inventory: none. This is a deterministic schema-setup ordering fix — no LLM-backed decision, no allow/deny surface, no authority change.

---

## 1. Over-block

No block/allow surface exists here. The change makes a previously-failing init succeed on pre-attribution DBs. No legitimate input is newly rejected.

---

## 2. Under-block

- **Other unmigrated columns.** This fixes the `attribution_key` ordering specifically. `head_hash` on `file_offsets` has no dependent index, so its ALTER-after-table ordering is safe and unchanged. Any FUTURE column added with a dependent index could reintroduce the class — mitigated by the documented invariant comment, not by a structural guard (a generic "all ALTERs before all indexes" reorderer was considered and judged over-engineering for two migrations).
- **Genuinely-corrupt DB.** If `token_events` is malformed beyond a missing column, init still throws (correct — that's not this bug).

---

## 3. Level-of-abstraction fit

Right layer: the bug is in TokenLedger's own schema-setup array, and the fix lives there. No call-site or API change; the migration was already present (just mis-ordered).

---

## 4. Signal vs authority compliance

No authority or signal involved — deterministic DDL ordering. Not applicable to product/message/external-operation judgment. Compliant by vacuity with `docs/signal-vs-authority.md`.

---

## 5. Interactions

- **NativeModuleHealer / Amendment 1.** Orthogonal: Amendment 1 fixes the ABI-mismatch open path; this fixes the post-open schema migration. An agent could hit one, the other, or both; the fixes compose (heal opens the DB, then the reordered schema migrates it).
- **TokenLedgerPoller / BurnDetector.** Both read `token_events` via TokenLedger; once init succeeds they see the migrated table with the backfilled `attribution_key` DEFAULT. No change to their logic.
- **Fresh installs.** Unchanged: the column is created with the table; the relocated ALTER throws duplicate-column → swallowed exactly as before.

---

## 6. External surfaces

No API/config/contract change. No `PostUpdateMigrator` entry needed — this is package code, not an agent-installed file; the migration runs in TokenLedger's own init on the next server start after the upgrade. Observable effect is positive: `/tokens/summary`, `/tokens/by-project`, `/tokens/sessions`, `/tokens/orphans` and the Dashboard Tokens tab go from 503 to live on every pre-attribution agent once it restarts onto the fixed version.

---

## 7. Rollback cost

Revert the `SCHEMA` reorder in one file. No data migration, no state, no contract. Reverted-to state = pre-attribution DBs stay 503 (the bug being fixed) — never worse. ~5 minutes.

---

## Second-pass review

**Concern:** Could reordering break a fresh DB, where the column already exists when the ALTER runs? No — `ALTER ADD COLUMN` on an existing column throws `duplicate column name`, which the init loop already swallows; the new regression test's idempotency case (B3) plus all 19 pre-existing TokenLedger tests (fresh `:memory:` DBs) confirm the fresh path is unchanged.

**Concern:** Data loss on the pre-existing row? No — `ALTER TABLE ADD COLUMN … DEFAULT` backfills existing rows with the default; test B2 asserts the pre-existing row survives with `attribution_key = 'unknown::pre-attribution'`.

**Concurrence:** Mechanically narrow (a single statement moved within an array), both sides of the boundary tested (pre-attribution DB migrates; fresh DB unchanged + idempotent re-init), one-file rollback to a strictly-not-worse state. Concurred.
