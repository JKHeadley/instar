# Upgrade Guide — vNEXT

## What Changed

### Git Sync Job — Intelligent Multi-Machine Synchronization

A new built-in job (`git-sync`) provides automatic, intelligent git synchronization between machines. Runs hourly with a zero-token gate that skips when nothing needs syncing.

**How it works:**
1. Gate script checks if local or remote changes exist (no Claude session if nothing to sync)
2. Gate classifies conflict severity: clean, state files, or code files
3. Model tier escalates based on severity: haiku (clean), sonnet (state conflicts), opus (code conflicts)
4. Claude session handles the sync intelligently — pulling, merging, resolving conflicts, pushing

**Key features:**
- **Zero-cost when idle**: Gate exits non-zero if nothing to sync — no session spawned
- **Tiered intelligence**: Simple syncs use haiku; complex code merges get opus
- **Conflict-aware**: Understands JSON state files vs code files and applies appropriate merge strategies
- **Safe**: Never force-pushes, never deletes branches, aborts cleanly on unresolvable conflicts

**Configuration:**
- Job is installed but disabled by default (enable in `.instar/jobs.json`)
- Requires git backup to be configured (`gitBackup.enabled: true`)
- Custom interval via `gitBackup.syncIntervalMinutes` (default: 60)

### Gate Script Installation

New agents get `.claude/scripts/git-sync-gate.sh` installed automatically. Existing agents receive it on next update via `refreshScripts`.

## What to Tell Your User

Your agent now has built-in git synchronization. If you use multiple machines, enable the `git-sync` job in `.instar/jobs.json` to automatically keep them in sync. It runs hourly, costs nothing when machines are already in sync, and intelligently handles merge conflicts when they arise.

## Summary of New Capabilities

- **git-sync job**: Built-in hourly git synchronization with intelligent conflict resolution
- **git-sync-gate.sh**: Zero-token pre-screening script that prevents unnecessary sessions
- **Tiered model selection**: Gate classifies conflict severity; scheduler escalates model tier accordingly
- **syncIntervalMinutes config**: Customizable sync frequency in `gitBackup` config
