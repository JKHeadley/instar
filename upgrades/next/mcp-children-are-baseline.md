## What Changed

- The idle check's list of "resident helper" processes now recognises any MCP server by the `mcp` token in its command line (`workspace-mcp`, `@plaud-ai/mcp@latest`), instead of only the handful it named by hand. A conversation whose only children are its MCP servers is idle again, so the idle timer starts and idle conversations are closed on schedule.

## What to Tell Your User

- If I run a Google Workspace, Plaud or similar helper in every conversation, my idle conversations are now cleaned up on the normal schedule instead of staying open forever and eventually blocking new ones. A cleaned-up conversation resumes the moment you message it.

## Summary of New Capabilities

- None new: an existing cleanup now works on agents that run MCP helpers whose names do not say "server".

## Evidence

- `tests/unit/mcp-children-are-baseline.test.ts` pins the exact process tree from the 2026-10-22 sagemind incident (claude → threadline bridge + `workspace-mcp --tool-tier complete`): fails on the previous pattern list, passes now; a Bash tool call that merely mentions `mcp` and a non-MCP child still count as work.
