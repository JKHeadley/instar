# Respawn build-context restore, in plain English

When an agent is building a fleet PR, it usually works inside a dedicated git worktree. That worktree is where the branch, uncommitted files, test output, installed dependencies, and local build decisions live.

The problem appears when the session dies and is respawned. The conversation can come back through resume, but the shell starts again in the agent's home checkout. The agent remembers the discussion but not the exact build checkout it was standing in. That can lead to a costly false start: checking the wrong repo, reinstalling dependencies, or rerunning gates against a different branch than the one that was actually being built.

This change gives SessionManager one narrow memory for that case: the live working directory reported by the tmux pane. While a session is running, SessionManager samples the pane's current directory and stores it in a small sidecar state record. The write is crash-safe because the state layer writes a temporary file and renames it into place, so a restart cannot leave half-written JSON behind.

On respawn, the behavior stays conservative. The session is still spawned from its normal home. If the saved directory is fresh, still exists, and is under an agent worktree path, the resumed conversation gets a short `[BUILD-CONTEXT RESTORE]` note before the user's continuation message. That note says which worktree the agent had been building in and tells the agent to return there before continuing.

Home-only sessions remain a strict no-op. If a session never left its normal home, if the saved path is stale, if the worktree was removed, or if the feature is not enabled, no restore note is injected. That boundary keeps normal conversational topics unchanged while protecting the dev/build sessions that need this memory.

The feature ships dark for ordinary agents and live only through the development-agent gate unless explicitly enabled. That lets dev agents dogfood the restore behavior before it becomes a broader fleet behavior.
