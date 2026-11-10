<!-- bump: patch -->
## What Changed

Adds the fold-marker tool policy for the Context Budget work: a PreToolUse hook (`fold-marker-guard.js`, on every Claude Code agent through the shared wildcard hook set, installed by init and every update) that restricts a session the fold coordinator has marked. Under a marker, file-reading tools, writes, sub-agents, web fetch and MCP tools are denied, and the only allowed call is an exact localhost lookup GET; every decision is logged per fold. A session with no marker is untouched: the hook exits after one environment read and one missing-file read. Markers are written by `src/monitoring/foldMarker.ts` and released with the fold's other carriers. Nothing writes a marker yet, so no session changes.

## What to Tell Your User

Nothing changes for you yet. This is what will keep my private bookkeeping turns from touching files or sending anything while I tidy a long conversation's memory.

## Summary of New Capabilities

- Session-scoped tool policy for fold turns; not used yet.

## Evidence

- Unit `tests/unit/fold-marker-guard-hook.test.ts` (11: the installed hook run as Claude Code runs it; byte-identity with the template; ESM host; agent-home resolution for worktree sessions; allowlist and escapes; stale marker vs record state; decisions log); anti-drift `tests/unit/standdown-guard-hook.test.ts`; integration `tests/integration/fold-marker-guard-settings.test.ts` (existing-agent settings + hook migration, idempotent, and the installed hook enforcing a real marker).
