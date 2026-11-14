/**
 * Threadline MCP over local HTTP — integration tier (full HTTP pipeline)
 * (docs/specs/threadline-mcp-local-http.md, acceptance criteria 1, 3, 4, 7, 8, 8a).
 *
 * Real createRoutes router + real authMiddleware (exact-path local-secret rule)
 * + real request-timeout map + the real ThreadlineMcpHttpService with the
 * server's own discovery / trust / resume objects, driven by the SDK's
 * streamable-HTTP client (what a session's client is) and by raw POSTs.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { startHarness, connectClient, mcpHeaders, toolCall, parseMcpBody, waitFor, AGENT_TOKEN, AGENT_NAME, type Harness } from './_mcp-http-harness.js';
import { ThreadlineMCPServer, type SendMessageParams, type SendMessageResult } from '../../../src/threadline/ThreadlineMCPServer.js';
import { AgentDiscovery } from '../../../src/threadline/AgentDiscovery.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import { createHttpRelayDiscoverer } from '../../../src/threadline/mcp-http-client.js';

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

const post = (url: string, headers: Record<string, string>, body: string) => fetch(url, { method: 'POST', headers, body });
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '');

/** A controllable send: each call parks until the test settles it. */
function parkedSends() {
  const calls: Array<{ params: SendMessageParams; origin: string | undefined; settle: (r: SendMessageResult) => void }> = [];
  const impl = (params: SendMessageParams, origin: string | undefined) =>
    new Promise<SendMessageResult>((settle) => { calls.push({ params, origin, settle }); });
  const ok = (id: string): SendMessageResult => ({ success: true, threadId: 't', messageId: id, deliveryPath: 'relay' });
  return { calls, impl, ok };
}

describe('criterion 3 / 8a — admission', () => {
  it('requires the local secret: 401 without, 401 for the agent token alone; 403 Origin / Cf-Connecting-Ip / X-Forwarded-For', async () => {
    h = await startHarness();
    const body = toolCall('threadline_agents', {});
    const base = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    expect((await post(h.url, base, body)).status).toBe(401);
    expect((await post(h.url, { ...base, Authorization: `Bearer ${AGENT_TOKEN}` }, body)).status).toBe(401);
    expect((await post(h.url, { ...base, Authorization: 'Bearer nope' }, body)).status).toBe(401);
    expect((await post(h.url, mcpHeaders(h.secret, 's', { Origin: 'http://127.0.0.1:1' }), body)).status).toBe(403);
    expect((await post(h.url, mcpHeaders(h.secret, 's', { 'Cf-Connecting-Ip': '1.2.3.4' }), body)).status).toBe(403);
    expect((await post(h.url, mcpHeaders(h.secret, 's', { 'X-Forwarded-For': '1.2.3.4' }), body)).status).toBe(403);
    expect((await post(h.url, mcpHeaders(h.secret), body)).status).toBe(200);
  });

  it('the handler repeats the check: /MCP/threadline/ (case + trailing slash) reaches it without the exact-path rule and is still refused', async () => {
    h = await startHarness();
    const variant = `http://127.0.0.1:${h.port}/MCP/threadline/`;
    const body = toolCall('threadline_agents', {});
    const base = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    expect((await post(variant, { ...base, Authorization: `Bearer ${AGENT_TOKEN}` }, body)).status).toBe(401);
    expect((await post(variant, mcpHeaders(h.secret, 's', { 'X-Forwarded-For': '1.2.3.4' }), body)).status).toBe(403);
  });

  it('other /mcp/* routes are unaffected: the agent token still reaches them and the local secret does not', async () => {
    h = await startHarness();
    const withToken = await fetch(`http://127.0.0.1:${h.port}/mcp/session/42`, { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } });
    expect([401, 403]).not.toContain(withToken.status);
    const withSecret = await fetch(`http://127.0.0.1:${h.port}/mcp/session/42`, { headers: { Authorization: `Bearer ${h.secret}` } });
    expect(withSecret.status).toBe(403);
    const loadWithSecret = await post(`http://127.0.0.1:${h.port}/mcp/load`, { 'Content-Type': 'application/json', Authorization: `Bearer ${h.secret}` }, '{}');
    expect(loadWithSecret.status).toBe(403);
  });

  it('an install with no agent token configured still refuses the route without the secret', async () => {
    h = await startHarness({}, { authToken: '' });
    const body = toolCall('threadline_agents', {});
    expect((await post(h.url, { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body)).status).toBe(401);
    expect((await post(h.url, mcpHeaders(h.secret), body)).status).toBe(200);
  });

  it('an agent-token rotation does not affect a wired session (the secret never rotates with the tunnel)', async () => {
    let token = 'token-before';
    h = await startHarness({}, { authToken: () => token });
    const client = await connectClient(h);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    token = 'token-after-tunnel-rotation';
    const r = await client.callTool({ name: 'threadline_agents', arguments: {} });
    expect((r as { isError?: boolean }).isError).toBeFalsy();
    await client.close();
  });

  it('GET and DELETE answer 405 (POST only); a batch array answers 400', async () => {
    h = await startHarness();
    expect((await fetch(h.url, { method: 'GET', headers: mcpHeaders(h.secret) })).status).toBe(405);
    expect((await fetch(h.url, { method: 'DELETE', headers: mcpHeaders(h.secret) })).status).toBe(405);
    const batch = `[${toolCall('threadline_agents', {}, 1)},${toolCall('threadline_agents', {}, 2)}]`;
    expect((await post(h.url, mcpHeaders(h.secret), batch)).status).toBe(400);
  });
});

describe('criterion 1 (integration) — the route stays mounted with the flag off', () => {
  it('a session wired before the flag went off keeps its tools', async () => {
    h = await startHarness();
    const client = await connectClient(h);
    h.enabled.value = false;
    expect(h.svc.planSpawn({ framework: 'claude-code', binaryPath: 'c', stripped: false })).toMatchObject({ transport: 'stdio', reason: 'flag-off', secretEnvFlags: [] });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('threadline_send');
    const r = await client.callTool({ name: 'threadline_agents', arguments: {} });
    expect((r as { isError?: boolean }).isError).toBeFalsy();
    await client.close();
  });
});

describe('criterion 4 — output parity and shared live objects', () => {
  it('threadline_discover / threadline_agents over HTTP equal the stdio helper for the same state; registry tools absent on both', async () => {
    h = await startHarness();
    fs.writeFileSync(path.join(h.stateDir, 'threadline', 'known-agents.json'), JSON.stringify({ agents: [
      { name: 'pp', port: 0, path: '', status: 'active', capabilities: ['conversation'], threadlineEnabled: true, threadlineVersion: '1.0', publicKey: 'ab'.repeat(32), framework: 'instar' },
    ] }));
    // The stdio helper's own construction (mcp-stdio-entry.ts), against the same disk.
    const stdio = new ThreadlineMCPServer(
      { agentName: AGENT_NAME, protocolVersion: '1.0', transport: 'stdio', requireAuth: false },
      {
        discovery: new AgentDiscovery({ stateDir: h.stateDir, selfPath: h.stateDir, selfName: AGENT_NAME, selfPort: h.port }),
        threadResumeMap: new ThreadResumeMap(h.stateDir, h.stateDir),
        trustManager: new AgentTrustManager({ stateDir: h.stateDir }),
        auth: null,
        sendMessage: async () => ({ success: false, threadId: '', messageId: '' }),
        getThreadHistory: async (threadId) => ({ threadId, messages: [], totalCount: 0, hasMore: false }),
        reloadTrustBeforePairingRead: true,
        registry: null,
        relayClient: createHttpRelayDiscoverer(h.port, AGENT_TOKEN),
      },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await stdio.getServer().connect(a);
    const stdioClient = new Client({ name: 'stdio', version: '1' });
    await stdioClient.connect(b);
    const httpClient = await connectClient(h);

    const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();
    expect(await names(httpClient)).toEqual(await names(stdioClient));
    expect((await names(httpClient)).some((n) => n.startsWith('threadline_registry_'))).toBe(false);
    for (const [tool, args] of [['threadline_agents', {}], ['threadline_discover', { scope: 'network' }]] as const) {
      const viaHttp = textOf(await httpClient.callTool({ name: tool, arguments: args }));
      const viaStdio = textOf(await stdioClient.callTool({ name: tool, arguments: args }));
      expect(viaHttp).toBe(viaStdio);
      expect(viaHttp).toContain('pp');
    }
    await httpClient.close();
    await stdioClient.close();
  });

  it('a threadline_trust change made over HTTP is visible to the server\'s trust manager (the same object)', async () => {
    h = await startHarness();
    const client = await connectClient(h);
    const before = h.trustManager.getProfile('peer-x')?.level;
    const r = await client.callTool({ name: 'threadline_trust', arguments: { action: 'grant', agent: 'peer-x', level: 'trusted', reason: 'test' } });
    expect((r as { isError?: boolean }).isError, textOf(r)).toBeFalsy();
    expect(before).not.toBe('trusted');
    expect(h.trustManager.getProfile('peer-x')?.level).toBe('trusted');
    await client.close();
  });

  it('wiring: the route\'s tool servers are built over the service\'s injected live objects, not null, not copies', async () => {
    h = await startHarness();
    const opts = (h.svc as unknown as { opts: { discovery: unknown; trustManager: unknown; threadResumeMap: unknown } }).opts;
    expect(opts.discovery).toBe(h.discovery);
    expect(opts.trustManager).toBe(h.trustManager);
    expect(opts.threadResumeMap).toBe(h.threadResumeMap);
    const server = (h.svc as unknown as { buildToolServer: (s: string, t: <T>(p: Promise<T>) => Promise<T>) => ThreadlineMCPServer }).buildToolServer('s', (p) => p);
    const deps = (server as unknown as { deps: Record<string, unknown> }).deps;
    expect(deps.discovery).toBe(h.discovery);
    expect(deps.trustManager).toBe(h.trustManager);
    expect(deps.threadResumeMap).toBe(h.threadResumeMap);
    expect(deps.registry).toBeNull();
    expect(deps.reloadTrustBeforePairingRead).toBe(false);
    expect((server as unknown as { requestContext: unknown }).requestContext).toEqual({ authenticated: true, isLocal: true });
  });

  it('each session\'s send carries its own originSessionName (the request header, never the server env)', async () => {
    const sends = parkedSends();
    h = await startHarness({ sendMessageImpl: sends.impl });
    const a = await connectClient(h, 'session-alpha');
    const b = await connectClient(h, 'session-beta');
    const pa = a.callTool({ name: 'threadline_send', arguments: { agentId: 'pp', message: 'from a' } });
    const pb = b.callTool({ name: 'threadline_send', arguments: { agentId: 'pp', message: 'from b' } });
    await waitFor(() => sends.calls.length === 2);
    const byMessage = Object.fromEntries(sends.calls.map((c) => [c.params.message, c.origin]));
    expect(byMessage).toEqual({ 'from a': 'session-alpha', 'from b': 'session-beta' });
    sends.calls.forEach((c, i) => c.settle(sends.ok(`m${i}`)));
    await Promise.all([pa, pb]);
    await a.close();
    await b.close();
  });
});

describe('criterion 7 — fallback and recovery', () => {
  it('readiness failure ⇒ stdio, tools still work, one degradation report', async () => {
    const reports: string[] = [];
    h = await startHarness({ probe: async () => { throw new Error('stalled'); }, report: (e) => reports.push(`${e.feature} ${e.reason}`), clientVersion: () => '2.1.310' });
    expect(h.svc.readinessSnapshot().ready).toBe(false);
    for (let i = 0; i < 3; i++) {
      expect(h.svc.planSpawn({ framework: 'claude-code', binaryPath: 'c', stripped: false })).toMatchObject({ transport: 'stdio' });
    }
    expect(reports.filter((r) => r.startsWith('ThreadlineMcpHttp.fallback'))).toHaveLength(1);
    // The route itself still serves (a session already on HTTP keeps working).
    const client = await connectClient(h);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
  });

  it('the real probe passes against the real route, and a ready probe yields the HTTP plan', async () => {
    h = await startHarness({ clientVersion: () => '2.1.310' });
    expect(h.svc.readinessSnapshot()).toMatchObject({ ready: true, url: h.url });
    expect(h.svc.planSpawn({ framework: 'claude-code', binaryPath: 'c', stripped: false })).toMatchObject({ transport: 'http', url: h.url });
  });

  it('a client connecting during a stalled server recovers on its next connect', async () => {
    const stall = { on: false };
    const held: Array<() => void> = [];
    h = await startHarness({}, { pre: (req, _res, next) => { if (stall.on && req.path.toLowerCase().startsWith('/mcp/threadline')) held.push(next); else next(); } });
    stall.on = true;
    const failed = await Promise.race([
      connectClient(h).then(() => 'connected', () => 'failed'),
      new Promise((r) => setTimeout(() => r('timed-out'), 500)),
    ]);
    expect(failed).not.toBe('connected');
    stall.on = false;
    const client = await connectClient(h);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('threadline_agents');
    await client.close();
    held.forEach((n) => n()); // release the stalled request so the server can close
  });
});

describe('criterion 8 — bounds', () => {
  it('the 33rd concurrent request gets 429; capacity returns when the work settles', async () => {
    const sends = parkedSends();
    h = await startHarness({ sendMessageImpl: sends.impl });
    const pending: Array<Promise<Response>> = [];
    for (let i = 0; i < 32; i++) {
      pending.push(post(h.url, mcpHeaders(h.secret, `s${Math.floor(i / 4)}`), toolCall('threadline_send', { agentId: 'pp', message: `m${i}` }, i + 1)));
    }
    await waitFor(() => sends.calls.length === 32);
    const extra = await post(h.url, mcpHeaders(h.secret, 'another'), toolCall('threadline_agents', {}));
    expect(extra.status).toBe(429);
    expect(h.svc.health().inFlight).toEqual({ total: 32, waits: 0 });
    sends.calls.forEach((c, i) => c.settle(sends.ok(`id${i}`)));
    await Promise.all(pending.map((p) => p.then((r) => r.text())));
    await waitFor(() => (h!.svc.health().inFlight as { total: number }).total === 0);
    expect((await post(h.url, mcpHeaders(h.secret, 'another'), toolCall('threadline_agents', {}))).status).toBe(200);
  });

  it('at most 24 slots go to waitForReply calls; a fifth call from one session gets 429', async () => {
    const sends = parkedSends();
    h = await startHarness({ sendMessageImpl: sends.impl });
    const pending: Array<Promise<Response>> = [];
    for (let i = 0; i < 24; i++) {
      pending.push(post(h.url, mcpHeaders(h.secret, `w${Math.floor(i / 4)}`), toolCall('threadline_send', { agentId: 'pp', message: `w${i}`, waitForReply: true, timeoutSeconds: 300 }, i + 1)));
    }
    await waitFor(() => sends.calls.length === 24);
    const wait25 = await post(h.url, mcpHeaders(h.secret, 'w-extra'), toolCall('threadline_send', { agentId: 'pp', message: 'x', waitForReply: true, timeoutSeconds: 300 }));
    expect(wait25.status).toBe(429);
    const notAWait = await post(h.url, mcpHeaders(h.secret, 'w-extra'), toolCall('threadline_agents', {}));
    expect(notAWait.status).toBe(200);
    const fifth = await post(h.url, mcpHeaders(h.secret, 'w0'), toolCall('threadline_agents', {}));
    expect(fifth.status).toBe(429);
    sends.calls.forEach((c, i) => c.settle(sends.ok(`id${i}`)));
    await Promise.all(pending.map((p) => p.then((r) => r.text())));
  });

  it('an inner wait that outlives the route deadline answers outcome-unknown first, and keeps its slot until it settles', async () => {
    const sends = parkedSends();
    h = await startHarness({ sendMessageImpl: sends.impl, routeAnswerMs: 300 });
    const client = await connectClient(h);
    const started = Date.now();
    const r = await client.callTool({ name: 'threadline_send', arguments: { agentId: 'pp', message: 'slow', waitForReply: true, timeoutSeconds: 300 } }, undefined, { timeout: 5_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toContain('Outcome unknown');
    expect(textOf(r)).toContain('may already have been sent');
    await new Promise((res) => setTimeout(res, 50));
    expect((h.svc.health().inFlight as { total: number }).total).toBe(1); // still running inside
    sends.calls[0].settle(sends.ok('late'));
    await waitFor(() => (h!.svc.health().inFlight as { total: number }).total === 0);
    await client.close();
  });

  it('a disconnected request keeps its slot until its inner call settles (no abort on disconnect)', async () => {
    const sends = parkedSends();
    h = await startHarness({ sendMessageImpl: sends.impl });
    const ac = new AbortController();
    const p = post(h.url, mcpHeaders(h.secret, 'gone'), toolCall('threadline_send', { agentId: 'pp', message: 'bye', waitForReply: true, timeoutSeconds: 300 }))
      .catch(() => null);
    void p;
    const req = fetch(h.url, { method: 'POST', headers: mcpHeaders(h.secret, 'gone2'), body: toolCall('threadline_send', { agentId: 'pp', message: 'bye2', waitForReply: true, timeoutSeconds: 300 }), signal: ac.signal }).catch(() => null);
    await waitFor(() => sends.calls.length === 2);
    ac.abort();
    await req;
    await new Promise((res) => setTimeout(res, 100));
    expect(h.svc.health().inFlight).toEqual({ total: 2, waits: 2 });
    sends.calls.find((c) => c.params.message === 'bye2')!.settle(sends.ok('x'));
    await waitFor(() => (h!.svc.health().inFlight as { total: number }).total === 1);
    sends.calls.find((c) => c.params.message === 'bye')!.settle(sends.ok('y'));
    await waitFor(() => (h!.svc.health().inFlight as { total: number }).total === 0);
  });

  it('a client already gone before the handler runs does not leak its slot (close fired earlier)', async () => {
    // A middleware before the route destroys the socket and waits for the
    // response's one-shot 'close' to fire, THEN lets the request reach the handler.
    const pre: import('express').RequestHandler = (req, res, next) => {
      if (req.headers['x-test-close-early'] !== '1') { next(); return; }
      res.once('close', () => next());
      req.socket.destroy();
    };
    const sends = parkedSends();
    h = await startHarness({ sendMessageImpl: sends.impl }, { pre });
    await fetch(h.url, { method: 'POST', headers: mcpHeaders(h.secret, 'early', { 'x-test-close-early': '1' }), body: toolCall('threadline_send', { agentId: 'pp', message: 'never' }) }).catch(() => null);
    await new Promise((res) => setTimeout(res, 200));
    await waitFor(() => (h!.svc.health().inFlight as { total: number }).total === 0, 2_000);
    expect(sends.calls.length).toBe(0); // no tool handler ran for a client that was already gone
    // Capacity is intact: a normal call still answers.
    expect((await post(h.url, mcpHeaders(h.secret, 'after'), toolCall('threadline_agents', {}))).status).toBe(200);
  });

  it('naming the reserved probe session without the service nonce earns no exemption from the per-session cap', async () => {
    const sends = parkedSends();
    h = await startHarness({ sendMessageImpl: sends.impl });
    const pending: Array<Promise<Response>> = [];
    for (let i = 0; i < 4; i++) {
      pending.push(post(h.url, mcpHeaders(h.secret, '__readiness-probe'), toolCall('threadline_send', { agentId: 'pp', message: `p${i}` }, i + 1)));
    }
    await waitFor(() => sends.calls.length === 4);
    const fifth = await post(h.url, mcpHeaders(h.secret, '__readiness-probe'), toolCall('threadline_agents', {}));
    expect(fifth.status).toBe(429);
    sends.calls.forEach((c, i) => c.settle(sends.ok(`id${i}`)));
    await Promise.all(pending.map((p) => p.then((r) => r.text())));
  });

  it('a call still running past the client timeout is reported as stuck and keeps its slot', async () => {
    const sends = parkedSends();
    const reports: string[] = [];
    h = await startHarness({ sendMessageImpl: sends.impl, stuckAfterMs: 100, report: (e) => reports.push(e.feature) });
    const p = post(h.url, mcpHeaders(h.secret), toolCall('threadline_send', { agentId: 'pp', message: 'stuck' }));
    await waitFor(() => (h!.svc.health().stuckOperations as number) > 0);
    expect(reports).toContain('ThreadlineMcpHttp.stuck');
    sends.calls[0].settle(sends.ok('z'));
    await (await p).text();
    await waitFor(() => h!.svc.health().stuckOperations === 0);
  });

  it('the first successful call is recorded per session name; the readiness probe is not', async () => {
    h = await startHarness();
    h.state.saveSession({ id: 'x1', name: 'n', tmuxSession: 'wired-1', status: 'running', startedAt: new Date(Date.now() - 3_600_000).toISOString(), framework: 'claude-code', threadlineMcpTransport: 'http' } as never);
    expect(h.svc.health()).toMatchObject({ sessionsOnHttp: 1, sessionsOnHttpNeverCalled: 1 });
    expect((await post(h.url, mcpHeaders(h.secret, 'wired-1'), toolCall('threadline_agents', {}))).status).toBe(200);
    expect(h.svc.health()).toMatchObject({ sessionsOnHttpNeverCalled: 0 });
    const firstCalls = (h.svc as unknown as { firstCallAt: Map<string, number> }).firstCallAt;
    expect(firstCalls.has('__readiness-probe')).toBe(false);
  });
});

// Keep parseMcpBody referenced for raw-body debugging helpers.
void parseMcpBody;
void AGENT_NAME;
