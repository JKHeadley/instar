/**
 * E2E — threadline_send surfaces the honest relay error through the full stack.
 *
 * Drives the REAL MCP transport: MCP client → `threadline_send` tool handler →
 * the REAL `sendMessageViaHttp` helper → a REAL `/threadline/relay-send` route
 * with the relay disconnected and no local target. The tool must report the
 * honest 503 ("Relay not connected and local delivery unavailable"), NOT the
 * old masked 400 ("Missing required fields…"). This closes the wiring gap the
 * mock-based e2e left open: if mcp-stdio-entry's helper wiring regresses, this
 * fails.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ThreadlineMCPServer } from '../../../src/threadline/ThreadlineMCPServer.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { AgentDiscovery } from '../../../src/threadline/AgentDiscovery.js';
import { sendMessageViaHttp } from '../../../src/threadline/mcp-http-client.js';
import { createRoutes } from '../../../src/server/routes.js';
import { StateManager } from '../../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { ThreadlineMCPDeps, ThreadlineMCPServerConfig } from '../../../src/threadline/ThreadlineMCPServer.js';
import type { InstarConfig } from '../../../src/core/types.js';

let projectDir: string;
let stateDir: string;
let relaySendServer: Server;
let relaySendPort: number;
let mcpServer: ThreadlineMCPServer;
let client: Client;

describe('E2E — threadline_send honest error through full stack', () => {
  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-send-e2e-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo-send-e2e' }));
    // No known-agents.json → no local target → relay-send hits the 503 path.

    // ── Real agent server exposing /threadline/relay-send (relay disconnected) ──
    const routeConfig = { projectDir, stateDir, projectName: 'echo-send-e2e', port: 4042 } as InstarConfig;
    const router = createRoutes({
      config: routeConfig,
      state: new StateManager(stateDir),
      threadlineRelayClient: null,
      startTime: new Date(),
    } as any);
    const app = express();
    app.use(express.json());
    app.use(router);
    await new Promise<void>((resolve) => {
      relaySendServer = app.listen(0, '127.0.0.1', () => {
        relaySendPort = (relaySendServer.address() as { port: number }).port;
        resolve();
      });
    });

    // ── Real MCP server whose sendMessage is the REAL helper over HTTP ──
    const deps: ThreadlineMCPDeps = {
      discovery: new AgentDiscovery({ stateDir, selfPath: projectDir, selfName: 'echo-send-e2e', selfPort: relaySendPort }),
      threadResumeMap: new ThreadResumeMap(stateDir, stateDir),
      trustManager: new AgentTrustManager({ stateDir }),
      auth: null,
      sendMessage: (params) => sendMessageViaHttp(params, relaySendPort, 'test-token'),
      getThreadHistory: async (threadId) => ({ threadId, messages: [], totalCount: 0, hasMore: false }),
    };
    const cfg: ThreadlineMCPServerConfig = {
      agentName: 'echo-send-e2e',
      protocolVersion: '1.0.0',
      transport: 'stdio',
      requireAuth: false,
    };
    mcpServer = new ThreadlineMCPServer(cfg, deps);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'send-e2e-client', version: '1.0.0' });
    await Promise.all([client.connect(ct), mcpServer.getServer().connect(st)]);
  });

  afterAll(async () => {
    try { await client?.close(); } catch { /* ignore */ }
    try { await mcpServer?.stop(); } catch { /* ignore */ }
    if (relaySendServer) await new Promise<void>((resolve) => relaySendServer.close(() => resolve()));
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'send-honest-error-e2e:cleanup' });
  });

  it('reports the honest relay error, not the masked missing-fields 400', async () => {
    const res = await client.callTool({
      name: 'threadline_send',
      arguments: { agentId: 'dawn', message: 'ping through the full stack', waitForReply: false },
    });

    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(res.isError).toBe(true);
    expect(text).toContain('Relay not connected and local delivery unavailable');
    expect(text).not.toContain('Missing required fields');
  });
});
