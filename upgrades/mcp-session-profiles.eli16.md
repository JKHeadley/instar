# Per-session MCP profiles — ELI16 overview

## The problem in plain words

When the agent opens a session for a topic, it gives that session a set of "MCP servers"
— helper tools like a browser (Playwright, which runs a whole Chromium) or an agent-to-
agent bridge. Right now every topic's session gets the FULL set, whether it needs them or
not. Those helpers are heavy and mostly idle, and stacked across many sessions they were a
big part of the process pile-up that crashed the machine on 2026-06-26.

## What this change does

This lets a topic launch its session with ONLY the MCP servers it actually needs. A topic
that just edits code doesn't need a browser, so it can launch with none of the heavy ones
(maybe just the lightweight agent-to-agent bridge). A browser topic still gets Playwright.
Fewer heavy helpers per session = a smaller baseline footprint.

How it works under the hood: Claude reads its MCP server list from a project file
(`.mcp.json`) at launch. When a topic has a configured profile, the agent writes a
filtered copy of that file (only the chosen servers) and launches the session pointed at
the filtered copy.

## The safety property that matters

This is **default-no-op**. If the feature is off, or a topic has no profile configured,
the session launches with the full `.mcp.json` exactly as today — byte-for-byte. A topic
only loses a server by EXPLICIT configuration. And on any error (a missing or unreadable
`.mcp.json`, anything unexpected) it falls back to the full set. So a session can never be
accidentally stranded without the tools it needs — the fail-safe always points at "give it
everything," never "give it nothing."

It ships **dark** (off by default) and is purely a launch-time choice — it never touches a
running session. This is the first of two steps: this one reduces the BASELINE footprint
(fewer heavy servers started in the first place); a later step will reclaim a heavy server
that's been sitting idle under a live session. The process-footprint monitor shipped
earlier lets us measure the reduction.

Config: `sessions.mcpProfiles` — `{ enabled, topicServers: { "<topicId>": ["server", …] } }`.
A topic not listed keeps the full set (so Playwright stays warm everywhere by default).
