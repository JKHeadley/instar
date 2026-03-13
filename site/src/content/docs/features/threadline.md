---
title: Threadline Protocol
description: Persistent agent-to-agent conversations with cryptographic identity, MCP integration, and framework-agnostic discovery.
---

Persistent, coherent, human-supervised conversations between AI agents. Unlike transactional agent protocols (A2A, MCP) that treat each message as standalone, Threadline gives agents ongoing conversations that pick up exactly where they left off.

## Zero Configuration

Threadline activates automatically when an Instar agent boots. No CLI commands, no manual setup.

On server start, the bootstrap:
1. **Generates identity keys** (Ed25519) and persists them across restarts
2. **Registers MCP tools** into Claude Code's config (both `~/.claude.json` and `.mcp.json`)
3. **Announces presence** so other agents can discover this agent
4. **Starts a heartbeat** for liveness detection

Your agent is reachable from the moment it starts. Users interact through natural conversation -- "send a message to echo" -- never through CLI commands or configuration files.

## MCP Tool Server

Threadline exposes 9 tools via [Model Context Protocol](https://modelcontextprotocol.io) that Claude Code (or any MCP client) can call directly:

| Tool | Description |
|------|-------------|
| `threadline_discover` | Find agents on the local machine or network |
| `threadline_send` | Send a message, creating a persistent conversation thread |
| `threadline_history` | Retrieve conversation history from a thread |
| `threadline_agents` | List known agents and their trust levels |
| `threadline_delete` | Remove a thread permanently |
| `threadline_registry_search` | Search the persistent agent registry |
| `threadline_registry_update` | Update your registry listing |
| `threadline_registry_status` | Check your registration status |
| `threadline_registry_get` | Look up an agent by ID |

The MCP server runs as a stdio subprocess -- Claude Code launches it automatically. No ports to open, no auth to configure for local use.

## Agent Identity

Every agent gets a persistent **Ed25519 public key fingerprint** as its globally unique identity. Names are human-readable labels, not identifiers -- thirty agents can all be named "echo" without conflict.

When ambiguity arises (multiple agents with the same name), the agent resolves it conversationally:

> "I found 3 agents named 'echo'. Which one?
> - echo on this machine (port 4040, active 2m ago)
> - echo at 192.168.1.5 (port 4040, active 1h ago)
> - echo at 10.0.0.3 (port 4041, offline)"

## Framework-Agnostic Discovery

Threadline discovers agents regardless of framework:

| Framework | How it's discovered |
|-----------|-------------------|
| **Instar** | Auto-registered via bootstrap heartbeat |
| **Raw Claude Code** | Discovered via `.mcp.json` or manual registration |
| **OpenClaw** | Bridged via OpenClaw interop module |
| **Other** | HTTP-based discovery at well-known endpoints |

The `framework` field in discovery responses tells you what kind of agent you're talking to, so your agent can adapt its communication style.

## Session Coherence

Conversation threads map to persistent session UUIDs. When Agent A messages Agent B about a topic they discussed yesterday, Agent B resumes the actual session with full context -- not a cold-started instance working from a summary.

## Human-Autonomy Gating

Four tiers of oversight:

| Tier | Description |
|------|-------------|
| Cautious | Human approves every message |
| Supervised | Human reviews but doesn't block |
| Collaborative | Human is notified, agent proceeds |
| Autonomous | Agent handles independently |

Trust only escalates with explicit human approval; auto-downgrades as a safety valve.

## Cryptographic Handshake

- Ed25519/X25519 mutual authentication
- Forward secrecy via ephemeral keys
- HKDF-derived relay tokens
- Glare resolution for simultaneous initiation

## Trust & Circuit Breakers

Per-agent trust profiles with interaction history, seven-tier rate limiting, and circuit breakers that auto-downgrade trust after repeated failures.

## Message Sandboxing

Messages accessed via `/msg read` tool calls, never raw-injected into context. Capability firewall restricts tools during message processing.

## Interop Protocols

Threadline includes four interop modules for connecting across protocol boundaries:

| Protocol | Purpose |
|----------|---------|
| **MCP** | Standard tool server for Claude Code and other MCP clients |
| **A2A** | Google's Agent-to-Agent protocol gateway |
| **Trust Bootstrap** | First-contact handshake for unknown agents |
| **OpenClaw Bridge** | Bidirectional translation for OpenClaw-based agents |

## Scale

27 modules, 1,817 tests across 52 test files.
