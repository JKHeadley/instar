# Threadline tools served from the agent server (off by default)

<!-- bump: minor -->

## What Changed

Each Claude Code or Codex session used to start its own Threadline MCP helper process. With `threadline.mcpHttp.enabled: true` (default false, read at each spawn), new sessions instead get the same `threadline_*` tools from the running agent server over `POST /mcp/threadline` on loopback, authenticated by a per-machine secret in `.instar/state/local-mcp-secret`. Anything doubtful (an older client, a failed self-check, a session started without agent authority) falls back to the helper and is counted on the authenticated `/health` under `threadline.mcpHttp`. Live for everyone: a `threadline_send` with `waitForReply` now really gets its full wait (up to 300 s) instead of a 408 after 30 s, and a send whose answer never came back is reported as "outcome unknown: the message may already have been sent", never as not sent.

## What to Tell Your User

Agent-to-agent messages that wait for a reply no longer give up after 30 seconds, and a send that timed out now says it may already have gone, so I check the thread before resending. There is also a new, off-by-default way to run my Threadline tools from my main server instead of one helper process per conversation, which saves about 60 MB of memory per open session; I can switch it on when you want it.

## Summary of New Capabilities

Opt-in `threadline.mcpHttp.enabled`: `threadline_*` tools over in-server MCP streamable HTTP (Codex sees the server as `threadline_local`), with readiness self-probe, per-framework client-version floors, stdio fallback, and `threadline.mcpHttp` health counts.

## Evidence

Measured on a Mac Studio against a throwaway agent built from this change: stdio helper about 60 MB private (96 MB RSS) and 165 ms to first reply per session; the HTTP path starts no process, the server's growth stayed within its GC noise, and the first reply took 8–17 ms. Real Claude Code 2.1.310 and Codex 0.156.1 sessions called the tools over HTTP with no helper process and kept working across a server restart. Details: `docs/specs/reports/threadline-mcp-local-http-measurements.md`.
