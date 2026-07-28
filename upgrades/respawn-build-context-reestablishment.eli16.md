# Respawn build-context restore

Developer agents can now remember the build checkout they were using before a respawn. When the feature is enabled and a resumed session had been working inside an agent worktree, the resumed conversation starts with a `[BUILD-CONTEXT RESTORE]` note pointing back to that worktree.

This is meant for fleet PR build sessions that die or restart mid-task. It does not move the tmux session's home directory, and it does nothing for normal home-only conversations. Stale or removed worktrees are skipped.
