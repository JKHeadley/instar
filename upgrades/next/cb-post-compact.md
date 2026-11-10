<!-- bump: patch -->
## What Changed

A new `PostCompact` hook (`.instar/hooks/instar/post-compact.sh`, added to `.claude/settings.json` on update) forwards the summary Claude Code writes when it compacts a conversation to a new authenticated route, `POST /hooks/post-compact`. The server scrubs it (credential shapes plus the exact values of the agent's own secrets) and stores it per conversation under `.instar/state/context-layers/<topic>/post-compact/` (owner-only permissions, at most 50 per conversation, git-ignored, machine-local, never served by the file viewer). Sessions without a conversation (jobs) record nothing. Observability only for now; nothing decides on these records yet. Fourth slice of the Context Budget: Layered Summaries spec.

## What to Tell Your User

When one of our long conversations gets compressed, I now keep the summary of what was compressed, privately on this machine, so the coming context work can check nothing important was lost.

## Summary of New Capabilities

- Claude Code compaction summaries are captured and stored per conversation, scrubbed of secrets.
- Rollback: revert; the leftover hook is harmless against an older server.

## Evidence

- Unit: `tests/unit/post-compact-store.test.ts`; integration: `tests/integration/post-compact-route.test.ts` (real AgentServer); e2e: `tests/e2e/post-compact-lifecycle.test.ts` (update path installs hook + settings; installed hook stores through the real server).
