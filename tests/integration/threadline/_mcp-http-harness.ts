/**
 * Shared harness for the Threadline MCP over local HTTP tests
 * (docs/specs/threadline-mcp-local-http.md): the REAL createRoutes router, the
 * REAL authMiddleware (with the exact-path local-secret rule), the REAL
 * request-timeout map, and the REAL ThreadlineMcpHttpService with the
 * server's live objects (discovery / trust / resume) built once.
 */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createRoutes } from '../../../src/server/routes.js';
import { authMiddleware, requestTimeout, buildRequestTimeoutOverrides } from '../../../src/server/middleware.js';
import { StateManager } from '../../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { AgentDiscovery } from '../../../src/threadline/AgentDiscovery.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import { ThreadlineMcpHttpService, type ThreadlineMcpHttpServiceOptions } from '../../../src/threadline/ThreadlineMcpHttpService.js';
import type { InstarConfig } from '../../../src/core/types.js';

export const AGENT_TOKEN = 'agent-token-for-tests';
export const AGENT_NAME = 'mcp-http-test-agent';

export interface Harness {
  projectDir: string;
  stateDir: string;
  port: number;
  url: string;
  server: Server;
  svc: ThreadlineMcpHttpService;
  discovery: AgentDiscovery;
  trustManager: AgentTrustManager;
  threadResumeMap: ThreadResumeMap;
  state: StateManager;
  enabled: { value: boolean };
  secret: string;
  waiters: Map<string, { resolve: (reply: string) => void; threadId: string; senderAgent: string; timer: ReturnType<typeof setTimeout> }>;
  close: () => Promise<void>;
}

/** A connected SDK streamable-HTTP client, exactly as a session's client connects. */
export async function connectClient(h: Harness, session = 'sess-a', extraHeaders: Record<string, string> = {}, secret = h.secret) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const transport = new StreamableHTTPClientTransport(new URL(h.url), {
    requestInit: { headers: { Authorization: `Bearer ${secret}`, 'X-Instar-Session': session, 'X-Instar-AgentId': AGENT_NAME, ...extraHeaders } },
  });
  const client = new Client({ name: 'test-session', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

export async function waitFor(pred: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function startHarness(
  over: Partial<ThreadlineMcpHttpServiceOptions> = {},
  opts: {
    /** '' = an install with no agent token configured. A function = a live (rotatable) token. */
    authToken?: string | (() => string);
    routeCtx?: Record<string, unknown>;
    /** The generic request timeout (production default 30 s). */
    defaultTimeoutMs?: number;
    /** Express middleware placed before everything (e.g. a stall switch). */
    pre?: express.RequestHandler;
    skipProbe?: boolean;
  } = {},
): Promise<Harness> {
  const base = process.env.TMPDIR && !process.env.TMPDIR.startsWith('/tmp') ? process.env.TMPDIR : os.tmpdir();
  const projectDir = fs.mkdtempSync(path.join(base, 'instar-mcp-http-'));
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: AGENT_NAME }));
  const state = new StateManager(stateDir);
  const discovery = new AgentDiscovery({ stateDir, selfPath: projectDir, selfName: AGENT_NAME, selfPort: 0 });
  const trustManager = new AgentTrustManager({ stateDir });
  const threadResumeMap = new ThreadResumeMap(stateDir, stateDir);
  const enabled = { value: true };
  const tokenOpt = opts.authToken === undefined ? AGENT_TOKEN : opts.authToken;
  const liveToken = (): string => (typeof tokenOpt === 'function' ? tokenOpt() : tokenOpt);
  const waiters = new Map<string, { resolve: (reply: string) => void; threadId: string; senderAgent: string; timer: ReturnType<typeof setTimeout> }>();
  let port = 0;
  const svc = new ThreadlineMcpHttpService({
    agentName: AGENT_NAME,
    stateDir,
    projectDir,
    get port() { return port; },
    agentToken: liveToken,
    enabled: () => enabled.value,
    discovery,
    trustManager,
    threadResumeMap,
    listSessions: () => state.listSessions(),
    report: () => {},
    ...over,
  } as ThreadlineMcpHttpServiceOptions);
  const config = { projectDir, stateDir, projectName: AGENT_NAME, port: 0, authToken: liveToken() } as InstarConfig;
  const router = createRoutes({ config, state, startTime: new Date(), threadlineMcpHttp: svc, threadlineReplyWaiters: waiters, ...(opts.routeCtx ?? {}) } as any);
  const app = express();
  if (opts.pre) app.use(opts.pre);
  app.use('/mcp/threadline', express.json({ limit: '256kb' }));
  app.use(express.json({ limit: '12mb' }));
  app.use(authMiddleware(() => liveToken() || undefined, AGENT_NAME, (req, res) => svc.admit(req, res)));
  app.use(requestTimeout(opts.defaultTimeoutMs ?? 30_000, buildRequestTimeoutOverrides()));
  app.use(router);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  port = (server.address() as { port: number }).port;
  config.port = port;
  svc.onListening('127.0.0.1', port);
  if (!opts.skipProbe) await svc.runProbe();
  const secret = fs.readFileSync(path.join(stateDir, 'state', 'local-mcp-secret'), 'utf-8').trim();
  return {
    projectDir, stateDir, port, url: `http://127.0.0.1:${port}/mcp/threadline`, server, svc, discovery, trustManager, threadResumeMap, state, enabled, secret, waiters,
    close: async () => {
      svc.stop();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/integration/threadline/_mcp-http-harness.ts:cleanup' });
    },
  };
}

export function mcpHeaders(secret: string, session = 'sess-a', extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${secret}`,
    'X-Instar-Session': session,
    'X-Instar-AgentId': AGENT_NAME,
    ...extra,
  };
}

export function toolCall(name: string, args: Record<string, unknown>, id = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}

/** Parse the first JSON-RPC message out of a JSON or SSE body. */
export function parseMcpBody(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('data:')) {
      const data = line.slice(5).trim();
      if (data) return JSON.parse(data);
    }
  }
  return null;
}
