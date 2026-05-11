/**
 * Server-side tests for POST /sessions/refresh.
 *
 * Stands up an express app with the real router and a minimal RouteContext
 * (only sessionRefresh + config). Verifies validation, the 202 ack, and
 * that refreshSession() is invoked async after the response flushes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';

interface MockSessionRefresh {
  refreshSession: ReturnType<typeof vi.fn>;
}

interface Server { url: string; close: () => Promise<void>; }

async function listen(app: express.Express): Promise<Server> {
  return new Promise(resolve => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => srv.close(() => r())),
      });
    });
  });
}

function buildApp(sessionRefresh: MockSessionRefresh | null): express.Express {
  const app = express();
  // Match production body limit (AgentServer uses 12mb) so the route's own
  // size validation is what rejects oversized payloads, not the bodyParser.
  app.use(express.json({ limit: '12mb' }));
  const ctx: any = {
    sessionRefresh,
    config: { authToken: 'test', stateDir: '/tmp', port: 0 },
    stateDir: '/tmp',
  };
  const router = createRoutes(ctx);
  app.use(router);
  return app;
}

describe('POST /sessions/refresh', () => {
  let sessionRefresh: MockSessionRefresh;
  let server: Server;

  beforeEach(async () => {
    sessionRefresh = {
      refreshSession: vi.fn().mockResolvedValue({ ok: true, newSessionName: 'new', topicId: 9235 }),
    };
    server = await listen(buildApp(sessionRefresh));
  });

  afterEach(async () => {
    await server.close();
    vi.useRealTimers();
  });

  async function api(path: string, body: unknown) {
    const res = await fetch(server.url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  }

  it('returns 400 when sessionName is missing', async () => {
    const r = await api('/sessions/refresh', { followUpPrompt: 'hi' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/sessionName/i);
  });

  it('returns 400 when sessionName has invalid characters', async () => {
    const r = await api('/sessions/refresh', { sessionName: 'bad name with spaces' });
    expect(r.status).toBe(400);
  });

  it('returns 400 when followUpPrompt is too large', async () => {
    const big = 'x'.repeat(500_001);
    const r = await api('/sessions/refresh', { sessionName: 'ok', followUpPrompt: big });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/followUpPrompt/);
  });

  it('returns 202 immediately on valid input', async () => {
    const r = await api('/sessions/refresh', { sessionName: 'echo-qalatra', followUpPrompt: 'continue' });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ ok: true, message: 'Refresh scheduled', sessionName: 'echo-qalatra' });
  });

  it('invokes sessionRefresh.refreshSession asynchronously after the response', async () => {
    const r = await api('/sessions/refresh', { sessionName: 'echo-qalatra', followUpPrompt: 'continue', reason: 'mcp-install' });
    expect(r.status).toBe(202);

    // The route schedules the call with setTimeout(..., 500). Wait long enough
    // for it to fire (>500ms in real time).
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(sessionRefresh.refreshSession).toHaveBeenCalledWith({
      sessionName: 'echo-qalatra',
      followUpPrompt: 'continue',
      reason: 'mcp-install',
    });
  });

  it('returns 503 when sessionRefresh is not wired', async () => {
    await server.close();
    server = await listen(buildApp(null));
    const r = await api('/sessions/refresh', { sessionName: 'echo-qalatra' });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/not enabled/i);
  });
});
