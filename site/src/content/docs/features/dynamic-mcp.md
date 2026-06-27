---
title: Dynamic MCP Lifecycle
description: Load heavy MCP servers on demand and offload them when idle, instead of carrying idle Chromium/Electron processes for the whole session.
---

Heavy MCP servers — Playwright's Chromium, Electron-based bridges — are expensive
and mostly idle. Carrying them for the life of every session was a dominant share
of the process footprint behind the 2026-06-26 resource-exhaustion incident. The
**Dynamic MCP Lifecycle** lets a claude-code session launch with a *lean* MCP set
and load a heavy server only when it's actually needed (a `claude --resume` restart
re-applies the new set without losing the conversation), then offload it when idle.

It ships **dark and experimental** behind `sessions.dynamicMcp.enabled` (off by
default): every `/mcp/*` route returns 503 when disabled, and the session-spawn path
is byte-identical when off. Single-server or no-`.mcp.json` agents are a no-op.

## How a session decides what to launch with

At spawn, a claude-code session resolves its MCP set: the committed loaded-set state
(if any) wins, else the configured lean baseline (`sessions.dynamicMcp.keepWarm`),
else the full `.mcp.json`. The resolution is fail-safe — any error falls back toward
the lean baseline (never re-launching every heavy server at once) and ultimately to
the full config, so a session is never stranded without its tools.

## The pieces

- **`DynamicMcpService`** is the composition root the routes call. It assembles the
  driver and stores and wires them to the host's real primitives (restart,
  preapproval, process capture, mid-tool-use probe). `DynamicMcpService` exposes
  three operations: read a topic's current MCP set, request a load, and request an
  offload.
- **`DynamicMcpManager`** is the driver that carries out a change. `DynamicMcpManager`
  serializes per-topic requests, writes the new set, restarts the session, and
  commits only on a confirmed restart — rolling back on any failure.
- **`McpLoadedSetStore`** durably records, per topic, which servers a session is
  running with. `McpLoadedSetStore` uses a two-phase committed flag so a change that
  writes a new set but fails to restart never becomes a phantom unapproved change.
- **`McpApprovalNonceStore`** issues the single-use approval codes described below.
  `McpApprovalNonceStore` binds each nonce to one exact change and expires it.

## Authorization — the agent cannot approve its own change

A load or offload completes only when the topic has a **live preapproval** (an active
autonomous run — the operator's own standing grant) **or** an operator-authenticated
approval. Because the agent is the only caller of these routes over the shared bearer
token, the agent-facing routes always act as the agent and never honor a nonce
supplied in the request body. A change the agent isn't preapproved for returns
`needs-approval` with a server-minted nonce and performs no restart — the agent
surfaces it and waits. The operator-authenticated approval route (which consumes the
nonce) is a tracked follow-up.

When the agent offloads a heavy server, it captures the server's child process IDs
before the restart and cleans them up after the new session is confirmed up — those
children reparent rather than dying with the old session, so a naive offload would
otherwise leak a browser process each time.

## API

- `GET /mcp/session/:topicId` — the servers a topic's session is currently running
  with, whether the topic is preapproved, and the provenance.
- `POST /mcp/load` — request that a server be loaded (`{ topicId, server }`).
- `POST /mcp/offload` — request that an idle server be dropped.

All routes are bearer-gated and return 503 while the feature is dark. The full design
and convergence record live in `docs/specs/DYNAMIC-MCP-LIFECYCLE-SPEC.md`.
