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
 *   THREADLINE_RELAY     — Relay WebSocket URL (default: wss://threadline-relay.fly.dev/v1/connect)
 *   THREADLINE_REGISTRY  — Enable registry tools (default: true if relay configured)
 *
 * This script:
 *   1. Reads agent config and Threadline state from disk
 *   2. Creates a ThreadlineMCPServer with stdio transport
 *   3. Optionally authenticates with relay for registry access
 *   4. Connects to Claude Code via stdin/stdout
 *   5. Handles tool calls until Claude Code disconnects
 */

import path from 'node:path';
import fs from 'node:fs';
import { ThreadlineMCPServer } from './ThreadlineMCPServer.js';
import { AgentDiscovery } from './AgentDiscovery.js';
import { ThreadResumeMap } from './ThreadResumeMap.js';
import { AgentTrustManager } from './AgentTrustManager.js';
import { IdentityManager } from './client/IdentityManager.js';
import { RegistryRestClient } from './client/RegistryRestClient.js';
import type { RegistryClient, RelayDiscoverer } from './ThreadlineMCPServer.js';
import { sendMessageViaHttp, getThreadHistoryViaHttp } from './mcp-http-client.js';
import { DEFAULT_RELAY_URL } from './constants.js';

// ── Parse CLI args ───────────────────────────────────────────────────

function parseArgs(): { stateDir: string; agentName: string } {
  const args = process.argv.slice(2);
  let stateDir = '';
  let agentName = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--state-dir' && args[i + 1]) {
      stateDir = args[++i];
    } else if (args[i] === '--agent-name' && args[i + 1]) {
      agentName = args[++i];
    }
  }

  if (!stateDir || !agentName) {
    process.stderr.write('Usage: mcp-stdio-entry --state-dir DIR --agent-name NAME\n');
    process.exit(1);
  }

  return { stateDir, agentName };
}

// ── Registry Client Setup ────────────────────────────────────────────

async function setupRegistryClient(
  stateDir: string,
  agentName: string,
): Promise<RegistryClient | null> {
  const relayUrl = process.env.THREADLINE_RELAY || DEFAULT_RELAY_URL;
  const registryDisabled = process.env.THREADLINE_REGISTRY === 'false';

  if (registryDisabled) {
    return null;
  }

  try {
    // Load or create agent identity
    const identityManager = new IdentityManager(stateDir);
    const identity = identityManager.getOrCreate();

    const client = new RegistryRestClient({
      relayUrl,
      identity,
      agentName,
      framework: 'instar',
      listed: process.env.THREADLINE_REGISTRY === 'true',
    });

    // Authenticate with relay to get registry token
    await client.authenticate();

    if (client.hasToken()) {
      process.stderr.write(`[threadline-mcp] Registry client authenticated\n`);
      return client;
    } else {
      process.stderr.write(`[threadline-mcp] Registry auth succeeded but no token received\n`);
      return client; // Still usable for unauthenticated searches
    }
  } catch (err) {
    process.stderr.write(
      `[threadline-mcp] Registry client setup failed (tools will be unavailable): ${err instanceof Error ? err.message : err}\n`
    );
    return null;
  }
}

// ── Relay discovery proxy (HTTP → agent server's relay client) ──────

/**
 * RelayDiscoverer implementation that proxies through the agent server's
 * /threadline/relay-discover endpoint. The MCP stdio subprocess has no
 * relay WebSocket of its own — the agent server is what holds the
 * persistent connection, so discover queries go through it.
 *
 * connectionState is cached briefly from the last /threadline/status read.
 * On every discover() call we re-check status first so cache fallback in
 * the MCP server's discover handler reflects the live relay state, not a
 * stale snapshot from MCP-process start.
 */
function createHttpRelayDiscoverer(serverPort: number, agentToken: string): RelayDiscoverer {
  let lastState = 'unknown';
  const refreshState = async (): Promise<string> => {
    try {
      const res = await fetch(`http://localhost:${serverPort}/threadline/status`);
      if (!res.ok) return (lastState = 'unavailable');
      const body = await res.json() as { relay?: { connected?: boolean } };
      lastState = body.relay?.connected ? 'connected' : 'disconnected';
      return lastState;
    } catch {
      return (lastState = 'unavailable');
    }
  };
  return {
    get connectionState(): string { return lastState; },
    async discover(filter) {
      // Refresh status before discovering so the MCP server's connectionState
      // check (which decides cache fallback) sees a live read, not a stale one.
      const state = await refreshState();
      if (state !== 'connected') return [];
      try {
        const res = await fetch(`http://localhost:${serverPort}/threadline/relay-discover`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${agentToken}`,
          },
          body: JSON.stringify({ filter }),
        });
        if (!res.ok) return [];
        const body = await res.json() as {
          success?: boolean;
          agents?: Array<{
            agentId: string; name: string; publicKey?: string;
            framework?: string; capabilities?: string[]; lastSeen?: string;
          }>;
        };
        return body.success && Array.isArray(body.agents) ? body.agents : [];
      } catch {
        return [];
      }
    },
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { stateDir, agentName } = parseArgs();

  const threadlineDir = path.join(stateDir, 'threadline');
  if (!fs.existsSync(threadlineDir)) {
    fs.mkdirSync(threadlineDir, { recursive: true });
  }

  // Read server port and auth token. Token: INSTAR_AUTH_TOKEN env first
  // (survives the secret-externalization refactor that moved authToken out of
  // config.json into the encrypted store), legacy plaintext-config fallback with
  // a string-type guard so the { "secret": true } placeholder produced by
  // SecretMigrator cannot leak through as a bogus Bearer.
  const configPath = path.join(stateDir, 'config.json');
  let serverPort = 4040;
  let agentToken = process.env.INSTAR_AUTH_TOKEN || '';
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      serverPort = config.port ?? 4040;
      if (!agentToken && typeof config.authToken === 'string') agentToken = config.authToken;
    } catch {
      // Use defaults
    }
  }

  // Instantiate dependencies from disk state
  const threadResumeMap = new ThreadResumeMap(stateDir, stateDir);
  const trustManager = new AgentTrustManager({ stateDir });
  const discovery = new AgentDiscovery({
    stateDir,
    selfPath: stateDir,
    selfName: agentName,
    selfPort: serverPort,
  });

  // Set up registry client (non-blocking — MCP server starts even if registry fails)
  const registryClient = await setupRegistryClient(stateDir, agentName);

  // Create MCP server with stdio transport
  const mcpServer = new ThreadlineMCPServer(
    {
      agentName,
      protocolVersion: '1.0',
      transport: 'stdio',
      requireAuth: false, // stdio = local, no auth needed
    },
    {
      discovery,
      threadResumeMap,
      trustManager,
      auth: null, // No auth for stdio
      sendMessage: (params) => sendMessageViaHttp(params, serverPort, agentToken),
      getThreadHistory: (threadId, limit, before) =>
        getThreadHistoryViaHttp(threadId, limit, serverPort, agentToken, before),
      registry: registryClient,
      relayClient: createHttpRelayDiscoverer(serverPort, agentToken),
    },
  );

  // Start — connects to stdin/stdout
  await mcpServer.start();

  // Keep process alive until Claude Code disconnects
  process.on('SIGINT', async () => {
    await mcpServer.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await mcpServer.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`MCP entry point failed: ${err}\n`);
  process.exit(1);
});
