# ELI16 — Worktree replies return to the owning agent

## What Changed

Instar agents use a small relay script to send a conversational response back to Telegram. That script normally runs from the agent's home directory, where it can read the live server port and agent identity. During development, however, a session can run from a nested Git worktree. The old script treated that worktree as if it were a separate agent home. It could miss the real port, fail its HTTP request, and then save the reply into a database named for an `unknown` agent inside the worktree. No live server owns or drains that database, so the message becomes a ghost row that could surface much later as a duplicate.

The relay now chooses its home conservatively. An explicit `INSTAR_AGENT_HOME` from the launcher wins. Without that variable, the script walks upward only when the current path contains the exact `/.worktrees/` structural marker, stopping immediately before that marker. In every ordinary directory it keeps today's behavior and uses the current directory. It never performs a broad upward search, because that could select another agent's configuration on a shared machine.

## Safety Behavior

Recovery still queues a transiently failed reply when the owning agent identity is known. If the identity is missing and would become `unknown`, the script prints a clear reason and exits non-zero without creating a database. The original message remains visible in the caller's transcript, making the failure recoverable and observable instead of silently stranded.

## Deployment

Fresh installs already source the canonical relay template. Existing agents receive the same template through PostUpdateMigrator: the v1.3.813 shipped-template hash is registered as a known safe predecessor, so an unmodified installed script is backed up and replaced during update while customized scripts retain the existing non-destructive `.new` behavior.

## Evidence

Integration tests execute the real Bash template against a real local HTTP server and SQLite recovery store. They cover worktree cwd resolution, explicit-home precedence, ordinary agent-home behavior, and unknown-id refusal with no orphan database. Unit tests verify migration output contains both safeguards and that historical shipped-template hashes remain complete.
