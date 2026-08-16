#!/usr/bin/env node
/**
 * mcp-stdio-entry — Standalone entry point for the Threadline MCP server.
 *
 * Claude Code launches this as a child process (stdio transport).
 * It reads agent state from disk and exposes up to 9 Threadline tools
 * (5 core + 4 registry tools if relay is configured).
 *
 * Usage (by Claude Code, not humans):
 *   node dist/threadline/mcp-stdio-entry.js --state-dir /path/.instar --agent-name my-agent
 *
 * Environment:
 *   THREADLINE_RELAY     — Relay WebSocket URL (default: wss://relay.threadline.dev/v1/connect)
 *   THREADLINE_REGISTRY  — Enable registry tools (default: true if relay configured)
 *
 * This script:
 *   1. Reads agent config and Threadline state from disk
 *   2. Creates a ThreadlineMCPServer with stdio transport
 *   3. Optionally authenticates with relay for registry access
 *   4. Connects to Claude Code via stdin/stdout
 *   5. Handles tool calls until Claude Code disconnects
 */
export {};
//# sourceMappingURL=mcp-stdio-entry.d.ts.map