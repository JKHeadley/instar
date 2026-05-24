# Side-Effects Review — vec0 probe false-corruption fix

**Change:** `SemanticMemory.open()` secondary probe-read no longer misclassifies a
`no such module: vec0` error as disk corruption. Virtual tables are excluded from
the probe (their storage lives in shadow tables that remain probed); any
`no such module` error is treated as a missing loadable extension, not corruption.

**Spec:** `docs/specs/SEMANTIC-MEMORY-CORRUPTION-RECOVERY-SPEC.md` (refinement of the
probe-read step it defines).

## Over-block / under-block analysis

- **Under-block risk (missing real corruption):** Low. The probe previously aborted
  on the *first* throwing table inside a single `try`. Now it iterates table-by-table
  and only *skips* tables that throw `no such module` (an extension-availability
  signal that cannot indicate page corruption — SQLite raises it before reading any
  data page). Genuine corruption errors (`database disk image is malformed`,
  `file is not a database`, torn-page reads) still quarantine. Vector data lives in
  vec0 *shadow tables* (`entity_embeddings_chunks`, `_rowids`, `_vector_chunks00`,
  `_info`) which are plain tables and remain in the probe set, so corruption of the
  embedding storage is still caught. The genuine-corruption regression test
  (`semantic-memory-vec0-probe.test.ts`, case 2) and the existing 12-case
  corruption-recovery suite confirm this.
- **Over-block risk (false corruption):** Eliminated for the vec0 case — that was the
  entire bug. The new exclusion (`sql NOT LIKE 'CREATE VIRTUAL TABLE%'`) is precise:
  it matches only objects declared as virtual tables, not regular tables whose data
  happens to reference a module.

## Level-of-abstraction fit

The fix sits exactly where the defect is — the probe loop inside `open()`. It does
not push the concern up into callers (the corruption-recovery contract is owned here)
nor down into VectorSearch/EmbeddingProvider (which already degrade correctly when the
extension is absent). No new public surface; the change is internal to `open()`.

## Signal-vs-authority compliance

This is a net **improvement** in signal/authority separation. The probe is a low-level
deterministic check, yet it exercises a *destructive* authority (quarantine + rebuild).
Previously it took that destructive action on a non-corruption signal (missing
extension). The fix narrows the probe's destructive authority to genuine corruption
only, and demotes the missing-extension condition to a logged signal that lets the
existing FTS5-only graceful-degradation path handle it.

## Interactions

- **initVectorSearch() / loadVecExtension():** Unchanged. After the probe completes
  cleanly, the existing async path loads sqlite-vec (when installed) and
  `createTable` is a no-op for the already-present vec0 table. On codey (sqlite-vec
  installed) this restores working vector recall; on hosts without sqlite-vec it
  stays FTS5-only — both without churn.
- **NativeModuleHealer / better-sqlite3 ABI:** Orthogonal. The ABI fix (Node-22 pin)
  governs whether better-sqlite3 loads at all; this governs the vec0 *loadable
  extension* probe. Both can be degraded independently.
- **invokeFromRemediator / db-corruption runbook:** Still routes to `open()`; its
  `rebuiltFromJsonl` flag is only set on genuine corruption now, so the runbook
  reports recovery accurately instead of on every boot.
- **WAL/-shm sidecars:** Untouched; only the in-`try` probe structure changed.

## Rollback cost

Trivial and isolated. Revert the single probe-loop edit in `SemanticMemory.ts`
(restore the original single `try` over all tables) and the regression test. No
schema change, no migration, no data format change — the on-disk DB is identical
either way. The only consequence of rollback is the return of the quarantine loop on
any DB carrying a vec0 table.

## Live evidence

codey reproduced the exact stderr (`Database corrupt (probe read failed: no such
module: vec0) — quarantining`) with 6 accumulated `.corrupt.<ts>` files. After deploy
+ two restarts: zero new quarantine files, the vec0 table persists across boots, 13
entities intact.
