/**
 * The one exemption from the Bearer gate for Local Verify's loopback proxy to a borrowed helper
 * (docs/specs/local-verify-borrowed-slices-count.md, "Build decisions: the attempt token"): on the
 * exact method and path, from a loopback socket with no tunnel or forwarding header, a request
 * carrying an attempt token of the right shape reaches the route (which checks the token against
 * the running verifies). Everything else about /local-verify stays behind the Bearer credential.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { authMiddleware } from '../../src/server/middleware.js';

const BEARER = 'test-bearer-token';
const ATTEMPT = 'a'.repeat(32);

async function buildApp(): Promise<{ server: Server; port: number; reached: string[] }> {
  const reached: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(BEARER));
  app.all('/local-verify/borrowed-proxy', (req, res) => { reached.push(`${req.method} proxy`); res.json({ ok: true }); });
  app.all('/local-verify/borrowed-proxy/extra', (_req, res) => { reached.push('extra'); res.json({ ok: true }); });
  app.all('/local-verify/borrowed/decision', (_req, res) => { reached.push('decision'); res.json({ ok: true }); });
  app.all('/local-verify/helper-here', (_req, res) => { reached.push('here'); res.json({ ok: true }); });
  app.all('/local-verify', (_req, res) => { reached.push('root'); res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return { server, port: (server.address() as { port: number }).port, reached };
}

describe('authMiddleware — the borrowed proxy\'s attempt-token exemption', () => {
  let h: Awaited<ReturnType<typeof buildApp>> | null = null;
  afterEach(() => { h?.server.close(); h = null; });
  const post = (path: string, headers: Record<string, string> = {}, method = 'POST') =>
    fetch(`http://127.0.0.1:${h!.port}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(method === 'GET' ? {} : { body: '{}' }) });

  it('lets a loopback POST with an attempt token through without the Bearer credential', async () => {
    h = await buildApp();
    const r = await post('/local-verify/borrowed-proxy', { 'X-Instar-Attempt-Token': ATTEMPT });
    expect(r.status).toBe(200);
    expect(h.reached).toEqual(['POST proxy']);
  });

  it('refuses the same request when it came through the tunnel or any forwarder, before the route', async () => {
    h = await buildApp();
    const tunnel = await post('/local-verify/borrowed-proxy', { 'X-Instar-Attempt-Token': ATTEMPT, 'CF-Connecting-IP': '203.0.113.9' });
    expect(tunnel.status).toBe(403);
    expect(await tunnel.json()).toEqual({ ok: false, reason: 'loopback-only' });
    const fwd = await post('/local-verify/borrowed-proxy', { 'X-Instar-Attempt-Token': ATTEMPT, 'X-Forwarded-For': '10.0.0.4' });
    expect(fwd.status).toBe(403);
    // The Bearer credential does not rescue a tunnelled call to this route either.
    const withBearer = await post('/local-verify/borrowed-proxy', { 'X-Instar-Attempt-Token': ATTEMPT, 'CF-Connecting-IP': '203.0.113.9', Authorization: `Bearer ${BEARER}` });
    expect(withBearer.status).toBe(403);
    expect(h.reached).toEqual([]);
  });

  it('needs an attempt token of the right shape; the Bearer credential alone is not one', async () => {
    h = await buildApp();
    expect((await post('/local-verify/borrowed-proxy')).status).toBe(401);
    expect((await post('/local-verify/borrowed-proxy', { 'X-Instar-Attempt-Token': 'short' })).status).toBe(401);
    expect((await post('/local-verify/borrowed-proxy', { 'X-Instar-Attempt-Token': 'A'.repeat(32) })).status).toBe(401);
    expect((await post('/local-verify/borrowed-proxy', { Authorization: `Bearer ${BEARER}` })).status).toBe(401);
    expect(h.reached).toEqual([]);
  });

  it('is one exact method and path: no other method, no path under it, and no other Local Verify route', async () => {
    h = await buildApp();
    const t = { 'X-Instar-Attempt-Token': ATTEMPT };
    expect((await post('/local-verify/borrowed-proxy', t, 'GET')).status).toBe(401);
    expect((await post('/local-verify/borrowed-proxy', t, 'PUT')).status).toBe(401);
    expect((await post('/local-verify/borrowed-proxy/extra', t)).status).toBe(401);
    expect((await post('/local-verify/borrowed/decision', t)).status).toBe(401);
    expect((await post('/local-verify/helper-here', t)).status).toBe(401);
    expect((await post('/local-verify', t)).status).toBe(401);
    expect(h.reached).toEqual([]);
    // The other routes keep working with the Bearer credential.
    expect((await post('/local-verify/borrowed/decision', { Authorization: `Bearer ${BEARER}` })).status).toBe(200);
    expect((await post('/local-verify/helper-here', { Authorization: `Bearer ${BEARER}` })).status).toBe(200);
    expect(h.reached).toEqual(['decision', 'here']);
  });
});
