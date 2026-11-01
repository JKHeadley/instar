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
import type { RegistryClient } from './ThreadlineMCPServer.js';
import { sendMessageViaHttp, getThreadHistoryViaHttp, requestSecretViaHttp, startPairingViaHttp, createPairingInviteViaHttp, createHttpRelayDiscoverer } from './mcp-http-client.js';
import { DEFAULT_RELAY_URL } from './constants.js';
import { resolveMcpAuthToken } from './mcpAuthToken.js';

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
// Shared with the in-server HTTP route: see createHttpRelayDiscoverer in
// mcp-http-client.ts.

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { stateDir, agentName } = parseArgs();

  const threadlineDir = path.join(stateDir, 'threadline');
  if (!fs.existsSync(threadlineDir)) {
    fs.mkdirSync(threadlineDir, { recursive: true });
  }

  // Read server port and auth token: INSTAR_AUTH_TOKEN env first (SessionManager
  // injects it per spawned session), legacy plaintext config second, the
  // encrypted vault third (a hand-started Codex on a secret-externalized install
  // has neither of the first two). See mcpAuthToken.ts for the full rationale —
  // every /threadline/* route this process drives is bearer-gated.
  const resolvedAuth = resolveMcpAuthToken(stateDir, process.env);
  const serverPort = resolvedAuth.port;
  const agentToken = resolvedAuth.token;
  if (!agentToken) {
    console.error('[threadline-mcp] no agent API token found (env INSTAR_AUTH_TOKEN, config.json authToken, or the vault) — sends/discover will be refused by the agent server (401)');
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
      // The helper's own environment carries the session name (stdio behaviour unchanged).
      sendMessage: (params) => sendMessageViaHttp(params, serverPort, agentToken, process.env.INSTAR_SESSION_NAME || undefined),
      getThreadHistory: (threadId, limit, before) =>
        getThreadHistoryViaHttp(threadId, limit, serverPort, agentToken, before),
      // Sealed-handoff keystone: self-mint over the loopback route (no bearer —
      // the on-disk authToken is vault-externalized).
      requestSecret: (params) => requestSecretViaHttp(params, serverPort),
      // Verified pairing v2: start a pending static-key pairing on the server (spec §3.2).
      startPairing: (peerFp) => startPairingViaHttp(peerFp, serverPort, agentToken),
      // Pairing by invite: make an invite on the server (a2a-pairing-invite-link).
      createInvite: (opts) => createPairingInviteViaHttp(opts, serverPort, agentToken),
      // This process holds its own trust-manager copy; re-read it before pairing status reads.
      reloadTrustBeforePairingRead: true,
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
