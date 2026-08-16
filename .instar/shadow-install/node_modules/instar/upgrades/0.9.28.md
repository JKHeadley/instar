# Upgrade Guide — vNEXT

## What Changed

### Orphan Process Reaper

New monitoring component that detects stale Claude Code processes that outlived their tmux sessions. Automatically cleans up orphaned processes to prevent resource waste.

### Silent Fallback Annotations

Process utility methods in OrphanProcessReaper use `@silent-fallback-ok` annotations for catch blocks where the target process may not exist — expected behavior for process inspection and cleanup utilities.

## What to Tell Your User

Your agent now automatically detects and cleans up stale processes. No configuration needed.

## Summary of New Capabilities

- **OrphanProcessReaper**: Detects and cleans up stale Claude Code processes
- **Process utility methods**: Safe fallbacks for process inspection (ps, kill)
