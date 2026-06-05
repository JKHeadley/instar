# Respawn build-context restore

## What to Tell Your User

Developer-agent respawns can now re-surface the worktree checkout they were building in before the restart. Normal home-only conversations are unchanged.

## Summary of New Capabilities

- SessionManager can record the live pane working directory for running sessions when the development-agent-gated feature is enabled.
- A resumed respawn receives a `[BUILD-CONTEXT RESTORE]` continuation note only when the prior cwd was a fresh, existing agent worktree.
- The sidecar state write is crash-safe through the state layer's temp-file plus rename path.

## What Changed

SessionManager now samples the live tmux pane cwd for enabled development-agent sessions and stores it in a crash-safe sidecar. Resume spawns prepend a restore note only for fresh, existing `.worktrees` paths; home-only sessions remain a no-op.
