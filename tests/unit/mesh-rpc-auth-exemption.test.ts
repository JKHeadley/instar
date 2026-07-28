/**
 * /mesh/rpc bearer-auth exemption (Multi-Machine Session Pool §L0).
 *
 * `/mesh/rpc` is the machine-to-machine command transport, authed by its signed,
 * recipient-bound Ed25519 MeshEnvelope (verify → RBAC → nonce in the dispatcher) —
 * NOT the API bearer token, which cannot work cross-machine since each install
 * holds its own authToken. The general authMiddleware was 401-ing every
 * `/mesh/rpc` POST (no bearer header) BEFORE the dispatcher's envelope check ran,
 * so the entire cross-machine pool (capacity/session-status, deliverMessage,
 * place/claim/transfer) was non-functional over the wire — it only ever passed
 * in-process tests that call the dispatcher directly.
 *
 * These tests pin that `/mesh/rpc` is exempt from the bearer gate (so the
 * dispatcher gets to run its own auth), while a normal protected path is NOT.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Application } from 'express';
import type { Server } from 'node:http';
import { authMiddleware } from '../../src/server/middleware.js';

const TOKEN = 'test-token-mesh';

function buildApp(): { server: Server; port: number } {
  const app: Application = express();
  app.use(express.json());
  app.use(authMiddleware(TOKEN));
  // /mesh/rpc must reach its handler WITHOUT a bearer token (envelope-authed).
  app.post('/mesh/rpc', (_req, res) => res.json({ reachedDispatcher: true }));
  // A normal protected route — must still require the bearer token.
  app.get('/pool', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

describe('authMiddleware — /mesh/rpc bearer exemption (§L0)', () => {
  let handle: { server: Server; port: number } | null = null;
  afterEach(() => { if (handle) handle.server.close(); handle = null; });

  it('lets /mesh/rpc through WITHOUT an Authorization header (reaches the dispatcher)', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/mesh/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: 'a', recipient: 'b', command: { type: 'session-status' }, epoch: 0, nonce: 'n', timestamp: 0, signature: 's' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reachedDispatcher: true });
  });

  it('still 401s a normal protected path without Authorization (the gate is intact)', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/pool`);
    expect(res.status).toBe(401);
  });

  it('also lets /mesh/rpc through even with a WRONG bearer token (the dispatcher, not the gate, authorizes it)', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/mesh/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer totally-wrong' },
      body: JSON.stringify({ command: { type: 'session-status' } }),
    });
    expect(res.status).toBe(200); // a wrong bearer is irrelevant; the envelope is the auth
  });
});
