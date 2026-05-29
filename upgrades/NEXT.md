# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Internal compliance + test correctness for the better-sqlite3 self-heal fix
(shipped functionally in v1.3.100).** No user-facing behavior change. Two
non-functional CI items from the previous cut are corrected: the self-heal's
binary backup/restore now uses `SafeFsExecutor.safeUnlinkSync` (destructive-tool
containment) instead of a direct `fs.unlinkSync`, and a stale source-text test
that asserted the rebuild "only uses --build-from-source" is updated to the new
ABI-pinned, prebuilt-first invariants (with `--build-from-source` retained as the
compile fallback).

## What to Tell Your User

Nothing to do. This is a code-hygiene + test follow-up to the SQLite self-heal
fix that already shipped — it does not change how your agent behaves.

## Summary of New Capabilities

- (none) — compliance + test correctness only. The native-module self-heal
  behavior is unchanged from v1.3.100.

## Evidence

- `npm run lint` clean (destructive-tool-containment passes).
- `tests/unit/lifeline/version-skew-recovery.test.ts` updated to assert
  ABI-pinned + prebuilt-first; `tests/unit/server-supervisor-preflight.test.ts`
  + `tests/unit/NativeModuleHealer.test.ts` green. 52 tests across the affected
  files pass; `tsc --noEmit` clean.
- Side-effects: `upgrades/side-effects/native-module-heal-abi-correct.md` (Fix-forward note).
