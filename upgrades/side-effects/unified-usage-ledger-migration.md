# Side-Effects Review — Unified usage ledger, existing agents on update

**Version / slug:** `unified-usage-ledger-migration`
**Date:** `2026-11-10`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

The spec's "Existing agents on update" items:
- **Agent awareness.** `USAGE_LEDGER_CLAUDEMD_SECTION(port)` (marker "Unified usage ledger — where are my tokens going") is in the generated CLAUDE.md for new agents and appended once by `migrateClaudeMd` for existing ones. The reference-layout splitter moves it into a topic reference file like every other section. The `CapabilityIndex` entry (Slice 4) makes `/usage/*` discoverable through `GET /capabilities`.
- **Phone allowlist.** `GET /mobile/usage`, owner only (Slice 4).
- **Backup.** `server-data/usage-ledger.snapshot.db` joins BackupManager's default `includeFiles`. The live database is not backed up (rebuilt from the snapshot plus source files).
- **State registry.** A `derived-usage-ledger` entry in `state-coherence-registry.json` for both files (derived cache, no transport, SQLite retention).
- **Git.** `migrateUsageLedgerGitignore` adds `.instar/server-data/usage-ledger*` to the project `.gitignore` and `server-data/usage-ledger*` to `.instar/.gitignore`, only where those files exist (never creates one), idempotently. Narrow on purpose: no other file under `server-data/` changes tracked status.
- **Release note.** `upgrades/next/unified-usage-ledger.md` replaces the slice-1 note and covers the whole feature.

## Decision-point inventory

None.

## 1. Over-block / 2. Under-block

Not applicable.

## 3. Level-of-abstraction fit

Each item uses the existing mechanism for its kind (section + marker, ignore-entry helper, default backup list, registry JSON).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No authority added.

## 4b. Judgment-point check (Judgment Within Floors standard)

None.

## 5. Interactions

The CLAUDE.md section adds ~1.6k characters to the full document; the layout's core budget is unaffected because the section is not a core heading (`claude-md-reference-layout.test.ts` passes). BackupManager suites pass.

## 6. External surfaces

CLAUDE.md text, ignore files, backup contents.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The section tells the agent to point the user at the console page rather than paste JSON, and to read coverage before calling a total complete.

## 7. Multi-machine posture (Cross-Machine Coherence)

The snapshot is per machine; git never carries either database.

## 8. Rollback cost

Text and list entries; removing them is a revert.

## Conclusion

Safe.

## Evidence pointers

- `tests/unit/PostUpdateMigrator-usageLedger.test.ts` — 4 tests: section added once with its reads; a fresh template already has it; ignore lines added once only where ignore files exist; snapshot in the backup default set and both files in the registry.
- `claude-md-reference-layout`, `scaffold-templates`, `system-templates`, `verify-deployed-templates`, `PostUpdateMigrator-templates-import-shape`, `BackupManager-*`: pass.
