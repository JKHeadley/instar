/**
 * Integration — POST /threadline/relay-send is bearer-gated end to end
 * (fb-829a7161-942).
 *
 * The report: an unauthenticated, empty-body POST over the Studio's public
 * tunnel URL reached the route's field validation (HTTP 400 "Missing required
 * fields"), not an auth refusal, because authMiddleware exempted the whole
 * `/threadline/` prefix. This harness mounts the REAL middleware with a token
 * and the REAL routes, then replays that exact request shape (Cf-Connecting-Ip
 * set, no token) and asserts it is refused before the handler runs. It then
 * proves the legitimate callers still work: a tokened request reaches the
 * handler, the stdio helper (`sendMessageViaHttp`) reaches the handler, and the
 * loopback self-mint route stays reachable without a bearer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../../src/server/routes.js';
import { authMiddleware } from '../../../src/server/middleware.js';
import { sendMessageViaHttp } from '../../../src/threadline/mcp-http-client.js';

const TOKEN = 'studio-agent-bearer-token';
const TUNNEL_HEADERS = { 'Cf-Connecting-Ip': '198.51.100.23', 'X-Forwarded-For': '198.51.100.23', 'Cf-Ray': 'abc123-SJC' };

let server: ReturnType<express.Express['listen']>;
let port = 0;
let url = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => TOKEN, 'studio'));
  const ctx: any = {
    config: { projectName: 'studio', authToken: TOKEN, stateDir: '/tmp', port: 4042 },
    tunnel: null,
    stateDir: '/tmp',
    threadlineRelayClient: null,
    startTime: new Date(),
  };
  app.use(createRoutes(ctx));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { port = (server.address() as AddressInfo).port; url = `http://127.0.0.1:${port}`; resolve(); });
  });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}

describe('POST /threadline/relay-send — the tunnel request from fb-829a7161-942', () => {
  it('an unauthenticated empty-body POST with tunnel headers is REFUSED (401), not field-validated (400)', async () => {
    const r = await post('/threadline/relay-send', {}, TUNNEL_HEADERS);
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: 'Missing or invalid Authorization header' });
  });

  it('an unauthenticated well-formed send with tunnel headers is refused the same way (nothing is sent)', async () => {
    const r = await post('/threadline/relay-send', { targetAgent: 'victim-peer', message: 'forged' }, TUNNEL_HEADERS);
    expect(r.status).toBe(401);
  });

  it('a wrong token is refused (403)', async () => {
    const r = await post('/threadline/relay-send', {}, { ...TUNNEL_HEADERS, Authorization: 'Bearer nope' });
    expect(r.status).toBe(403);
  });

  it('the SAME request WITH the agent token reaches the handler (its field validation answers)', async () => {
    const r = await post('/threadline/relay-send', {}, { ...TUNNEL_HEADERS, Authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(400);
    expect(r.json?.error).toMatch(/Missing required fields: targetAgent, message/);
  });

  it('the sibling own-surface routes are gated the same way', async () => {
    for (const [method, path] of [['POST', '/threadline/relay-discover'], ['GET', '/threadline/status'], ['POST', '/threadline/hub/bind'], ['GET', '/threadline/conversations'], ['GET', '/threadline/pairing/invites']] as const) {
      const res = await fetch(`${url}${path}`, { method, headers: { 'Content-Type': 'application/json', ...TUNNEL_HEADERS }, body: method === 'POST' ? '{}' : undefined });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('legitimate callers still work', () => {
  it('the stdio MCP helper (sendMessageViaHttp) with the token reaches the handler, not the gate', async () => {
    // Relay client is null in this harness, so the honest outcome is the
    // route's own 503/404 — NOT a 401 from the middleware.
    const r = await sendMessageViaHttp({ targetAgent: 'some-peer', message: 'hello' }, port, TOKEN);
    expect(r.success).toBe(false);
    expect(r.error ?? '').not.toMatch(/Authorization/);
    expect(r.error ?? '').toMatch(/Relay not connected|not found|unavailable|no live|refused/i);
  });

  it('the stdio MCP helper WITHOUT a token is refused by the gate (the helper surfaces it verbatim)', async () => {
    const r = await sendMessageViaHttp({ targetAgent: 'some-peer', message: 'hello' }, port, '');
    expect(r.success).toBe(false);
    expect(r.error ?? '').toMatch(/Authorization/);
  });

  it('GET /threadline/health (peer discovery) stays public — a tunnel probe without a token is answered', async () => {
    const res = await fetch(`${url}/threadline/health`, { headers: TUNNEL_HEADERS });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('POST /threadline/secrets/request (loopback self-mint) still needs no bearer on loopback', async () => {
    const r = await post('/threadline/secrets/request', { label: 'x' });
    // Loopback + no forwarded header: passes the gate; the handler decides (any status but 401/403).
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(403);
  });
});
