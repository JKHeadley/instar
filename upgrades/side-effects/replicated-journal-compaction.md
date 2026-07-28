# Side-Effects Review — Replicated journal compaction

## Summary

Adds a store-agnostic, one-shot compactor for registered replicated-record JSONL streams. It streams the source, keeps the HLC-max row per `(origin, recordKey)`, preserves invalid rows, writes a temporary stream, syncs it, rebuilds the compacted witness map, and atomically renames only after parity.

## Decision points

- The path is explicit opt-in and dry-run-first; it never runs merely because replication is enabled.
- Rename is the only commit point. Temp write, fdatasync, compacted-byte witness rebuild, and parity all precede it.
- Parity is checked twice: once for the planned winners and again after parsing the persisted temporary stream.
- A parity mismatch throws, deletes only the temporary file, and keeps the source.
- Memory scales with live keys, not historical journal rows; the full source is never materialized.

## Interactions and risks

- The compactor runs during server wiring before replicated emitters and pull loops attach, avoiding concurrent record appends during replacement.
- Sequence numbers on retained rows are preserved. Readers already tolerate sparse history and fold by HLC.
- Invalid/torn parseable rows are not candidates for supersession and are carried through.
- After a real rename, the shared reader rebuilds its derived index from committed files.
- PII record kinds use the same registry/schema validation and gain no new fields or egress.
- Missing journal or peers directories mean no streams exist yet and are handled as an explicit no-op.
- ConfigDefaults gains no new `enabled` gate; the hand-authored dark-gate attribution map is advanced by the five inserted lines and retains the same path set.

## Rollback

Turning the run flag off disables the path. Reverting code requires no schema migration. Already-compacted streams remain valid journals containing the same live witnesses; dead intermediate versions are intentionally unrecoverable after a successful parity-checked commit.

## Evidence

- Unit: superseded rows collapse and latest witness survives.
- Integration: default dry-run reports `3 -> 1` without writing; real run shrinks bytes and preserves reader witness.
- E2E/crash: injected interruption after temp fsync and before rename leaves the original byte-for-byte intact and cleans the temp.
- Full lint, TypeScript, build, and the existing witness-index integration test pass.

## Class closure

The disk-bloat class is closed structurally: future controlled compaction uses coded streaming, a derived-witness correctness oracle, and an atomic commit point rather than manual journal editing or in-place mutation.
