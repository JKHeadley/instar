# Upgrade Guide — Shared Local History Child Custody

<!-- bump: patch -->

## What Changed
The local-history parser now uses a shared process-held worker lane. A replacement cannot admit a second worker while an orphan child retains custody. The actual parser child checks its generation and holds custody before acknowledging readiness; private input begins only afterward. Private SQLite files and sidecars use existing storage exclusions and inode protections.

## What to Tell Your User
The local-history import is still being built. Its worker protection now prevents a replacement session from starting another import worker while an interrupted worker remains alive. Importing through the app is not yet available from this change.

## Summary of New Capabilities
No new action or API is enabled. This is supporting work for the selected-local-history workflow tracked in topic 143810.

## Evidence
Real-process tests kill a parent while its child remains alive, prove the lane stays busy, then prove recovery after actual child exit. Tests also refuse stale generations before private bytes, reject WAL mode without changing it, and exercise success and refusal through the actual parser child. Complete normal verification remains required before release.
