---
user_announcement:
  - audience: agent-only
    maturity: preview
    summary: "A topic's session can now launch with only the MCP servers it needs (per-session profiles), cutting the heavy idle-MCP footprint. Dark, default-no-op."
---

## What Changed

Added **per-session MCP profiles** — lever 1 of the dynamic-MCP-lifecycle work. A topic's
interactive session can now launch with ONLY its profiled MCP servers (a filtered
`.mcp.json`) instead of the full project set. Heavy, mostly-idle MCP servers (a whole
Chromium for Playwright, an Electron for some bridges) stacked across sessions were a
dominant share of the steady-state process footprint behind the 2026-06-26 resource panic;
this cuts the baseline by not starting servers a topic doesn't need.

DEFAULT-NO-OP and dark: when the feature is off, or a topic has no profile, the session
launches with the full `.mcp.json` byte-for-byte as today, and every error path fails safe
to the full set — a session can never be stranded without its tools. Config:
`sessions.mcpProfiles` = `{ enabled, topicServers: { "<topicId>": ["server", …] } }`. A
topic not listed keeps the full set (so Playwright stays warm everywhere by default).

This is the BASELINE reducer; a later increment (lever 2) will reclaim a heavy server that
has been idle under a live session, gated on a mid-tool-use safety check. The
process-footprint monitor shipped earlier lets us measure the reduction.

## Evidence

**Before:** every topic's interactive session launched with the full `.mcp.json` (here:
playwright + threadline), so a plain coding topic still started Playwright's Chromium it
never used — the kind of idle heavyweight that accumulated into the panic's footprint.

**After:** when a topic is profiled, `spawnInteractiveSession` (claude-code) writes a
filtered `.mcp.json` and launches with `--strict-mcp-config --mcp-config <filtered>`. Unit
tests pin the resolver (off ⇒ null; no-profile ⇒ null; explicit subset; explicit empty;
de-dupe) and the filter (keeps only allowed, preserves other fields, no mutation, tolerates
a missing `mcpServers`). Wiring tests assert the builder is actually called in the
interactive claude-code branch with the topic id, pushes onto the launch argv, and returns
`[]` (full set) on the default/error paths. `tsc` clean.

## What to Tell Your User

If a user asks why a topic's session has fewer tools, or how to slim a session's footprint,
the answer is per-session MCP profiles — a topic launches with only the servers it needs,
and anything unconfigured keeps the full set. It only changes what a session starts with; it
never removes tools from a running session.

## Summary of New Capabilities

- Per-topic MCP server profiles resolved at interactive session launch (claude-code).
- A filtered `.mcp.json` is written per session; the source file is never mutated.
- Default-no-op + fail-safe-to-full-set; dark by default (`sessions.mcpProfiles`).
