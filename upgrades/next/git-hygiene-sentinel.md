# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

GitSync now filters broad Instar state commits path by path before staging. It
uses the existing file classifier to skip local runtime directories and
secret-bearing agent config, while still allowing legitimate shared state to
sync.

This closes a git hygiene failure mode where a tracked local runtime file could
keep being staged by a broad Instar state sync even after ignore rules were
corrected. The classifier now recognizes Instar-local runtime paths, local
agent config, token directories, machine identity files, Telegram inbound files,
session files, reports, views, and shadow installs.

Cleanup remains possible: deletions of local-only paths are still stageable so
agents can remove previously tracked bad files.

## What to Tell Your User

- **Cleaner automatic syncs**: "I’m less likely to accidentally carry local
  runtime files or private agent configuration into source control when I sync
  my own state."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| GitSync local-state hygiene guard | Automatic during Instar state sync |
| Instar-local runtime classification | Automatic in file classification and sync staging |
| Cleanup-safe local-only deletions | Automatic when a cleanup commit removes previously tracked local-only files |

## Evidence

The local Codey checkout reproduced the failure class with hundreds of dirty or
tracked local artifacts, including Telegram inbound files, sessions, reports,
runtime ledgers, identity/config material, and generated cache state. A broad
state add would not distinguish legitimate shared state from these local-only
paths.

The product change was verified in an isolated Instar worktree with focused
tests covering agent-local secret/runtime classification, legitimate state
staging, rename destination parsing, deletion allowance, and status-failure
fallback behavior. The focused run passed 137 tests across FileClassifier and
GitSync.

After the first PR CI run, two additional regressions were reproduced locally:
an older sync edge-case fixture still treated local config as normal structured
data, and the no-silent-fallback ratchet counted an existing binary conflict
fallback after nearby edits shifted its detection window. Both were fixed, and
the expanded local verification passed 191 tests across the edge-case,
no-silent-fallback, FileClassifier, and GitSync suites. TypeScript typecheck
passed, and the full build completed successfully.
