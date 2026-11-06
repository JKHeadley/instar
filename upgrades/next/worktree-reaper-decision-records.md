# Worktree reaper and capacity refusal

## What Changed

The worktree reaper no longer counts the commit gate's own untracked or ignored decision records and traces as uncommitted work. Before it removes a checkout it copies those records to `.instar/instar-dev-decisions-archive/<worktree>/`, checks each copy byte for byte, and keeps the checkout if the copy fails. Only files named the way the gate names them qualify; staged records, locally edited tracked records, nested files and symlinks still keep the checkout. The reaper's off-by-default switch is unchanged.

When `instar worktree create` refuses because `.worktrees/` holds 500 directories, the message now says how many are git checkouts, how many are other folders, and what those folders are by name. The limit and what counts toward it are unchanged.

## What to Tell Your User

Nothing changes in day-to-day use. If I ever run out of room for new working copies, my report of what is filling that folder is now specific. Cleanup of old working copies also keeps a copy of their review records.

## Summary of New Capabilities

- The worktree reaper archives commit-gate records before removing a checkout, so no audit record is lost with the checkout.
- The worktree capacity refusal names what is filling the folder.
