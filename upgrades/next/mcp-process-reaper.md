<!-- bump: minor -->

## What Changed

Added the **MCP-Process Reaper** (`McpProcessReaper`) — a new resource-hygiene
reaper that reclaims leaked MCP-server child processes (Playwright MCP, mcp-remote
bridges, instar's stdio MCP) whose owning session has died or gone stale. Killing a
session's main process does not cascade to its MCP-server children, so they
re-parent and accumulate for days (the fleet had ~80, up to 5 days old, as a
persistent CPU-load floor). The existing OrphanProcessReaper reaps the session-level
process but not its MCP descendants — this closes that gap.

It is a separate sibling reaper (the shared session-reap authority path is
untouched), with a strict safety model: it never reaps a process under a live or
tracked session, never touches a non-instar (external) session's processes, only
matches three exact MCP signatures, and requires the process to be old. Ships OFF +
dry-run; a read-only report is available at GET /processes/mcp-reaper.

## What to Tell Your User

Your machine no longer slowly fills up with leftover helper programs from old agent
sessions. When a session ends, the little background helpers it started (the browser
helper, the data-bridge helper) used to keep running for days and quietly eat CPU.
There is now a cleanup robot that spots those genuinely-abandoned helpers and clears
them — while never touching anything a live session still needs, and never touching
your own programs. It starts in a watch-only mode so it shows what it would clean
before it cleans anything.

## Summary of New Capabilities

- New read-only endpoint GET /processes/mcp-reaper — shows every matched MCP helper,
  whether it is keep or reap-eligible and why, its owning session, and whether
  reaping is armed.
- New config block monitoring.mcpProcessReaper (off + dry-run by default).
- New audit trail at logs/mcp-reaper-audit.jsonl recording every keep/would-reap/reap
  decision.

## Evidence

Three test tiers, all green: 18 unit tests covering both sides of every keep/reap
boundary (including never reaping a live session's 10-day-old helper, dry-run kills
nothing, and the per-pass blast-radius cap); 2 integration tests on the route
(503 when unwired, 200 snapshot when wired); 1 e2e test confirming the route is alive
through the real AgentServer plumbing (200, not 503). Full typecheck clean.
