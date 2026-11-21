<!-- bump: patch -->
## What Changed

Recommended services re-offers, slice C: the `state-loss-risk` problem. A restore from a local snapshot (CLI or route) now leaves `state/restore-marker.json` after the copy. The next start reads and clears it even with re-offers off, and with them on it re-offers GitHub private backup when the restore is recent, no GitHub backup is verified and no other machine holds a copy. A marker that can't be written never fails a restore.

## What to Tell Your User

Nothing changes yet (off by default). When it's on, if the agent is restored from a backup kept on its own machine and no copy exists anywhere else, it asks about the GitHub backup once more, if you'd said no before.

## Summary of New Capabilities

- `state-loss-risk` re-offer source and the restore marker. No new routes.

## Evidence

- Unit: marker read/write/clear and a real `BackupManager` restore. Integration: four cases (fresh marker, a copy elsewhere, switch off, stale marker). E2E: a marker on a single machine is read once at start and cleared. Existing BackupManager tests unchanged.
