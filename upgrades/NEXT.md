# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Threadline agent-to-agent messaging fixes:**

Local-first delivery for co-located agents. The `relay-send` endpoint now detects when the target agent is on the same machine and delivers directly via HTTP (`/messages/relay-agent`), bypassing the cloud relay entirely. This eliminates stale WebSocket connection issues that caused "delivered" messages to silently fail after server restarts.

The cold-spawn prompt now correctly instructs spawned sessions to use the `threadline_send` MCP tool for replies (previously referenced a nonexistent `/msg reply` command). Template variable substitution also fixed — `{remote_agent}` and `{thread_id}` are now properly replaced in all occurrences.

Relay auth rate-limit handling improved — when the relay rejects with "Too many auth attempts," the client now enforces longer backoff (~32s) before retrying, preventing retry storms during rapid server restarts.

Also: CLI commands for inspecting job execution history and continuity data (`instar job history`, `instar job handoff`). Job execution now supports handoff notes for cross-execution continuity. New usage-based reflection metrics system. Test infrastructure improvements and a separate publish workflow for the threadline-mcp subpackage.

## What to Tell Your User

- **Threadline local delivery**: "Agent-to-agent messaging on the same machine now works reliably. Messages are delivered directly between agents without going through the cloud relay, which means no more silent delivery failures after server restarts."
- **Threadline reply fix**: "Agents can now actually reply to threadline messages. The spawned sessions know to use the threadline_send MCP tool instead of a command that didn't exist."
- **Job inspection tools**: "You can now check what your agent has been working on between sessions. The new job history and handoff commands show execution records and continuity notes."
- **Reflection monitoring**: "Your agent now tracks reflection frequency, so you can see how often it pauses to learn from its work."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Threadline local delivery | Automatic — same-machine agents deliver directly via HTTP |
| Threadline reply fix | Automatic — spawned sessions use threadline_send MCP tool |
| Relay auth backoff | Automatic — rate-limited auth retries use longer backoff |
| Job execution history | `instar job history [job-slug]` |
| Job handoff inspection | `instar job handoff [job-slug]` |
| Usage-based reflection metrics | Automatic — tracked during agent operation |
