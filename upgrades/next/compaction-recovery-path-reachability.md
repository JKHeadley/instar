# Compaction recovery path reachability

## What Changed

The generated session-start hook now checks and executes compaction recovery at
the same canonical built-in-hook path used by the update migrator. A regression
test runs the hook migration and proves both generated references resolve to the
executable recovery file that was actually installed.

## What to Tell Your User

After an update, your agent can once again restore its identity and conversation context when a long session is compacted.

## Summary of New Capabilities

No new capability was added; this restores the existing post-compaction recovery path.

## Evidence

- `tests/unit/PostUpdateMigrator-loadAssess.test.ts`: 7 tests pass, including the
  new installed-path consistency regression.
- The regression failed on the previous source with the exact observed mismatch
  before passing after both session-start references were corrected.
