/**
 * Sealed-handoff KEYSTONE — agent self-mint of a Secret Drop request.
 *
 * Proves the keystone truth from the spec: "an agent can mint its own one-time
 * submit URL WITHOUT the externalized bearer." The Threadline MCP server is a
 * separate stdio process that can only read the on-disk config.json, where the
 * authToken is vault-externalized ({secret:true}) — so it can't present a valid
 * bearer. The loopback-only POST /threadline/secrets/request route closes that
 * gap by living under the /threadline/* auth-bypass umbrella, with explicit
 * localhost enforcement added because minting a credential URL is sensitive.
 *
 * Harness mounts the REAL authMiddleware with a configured token, so the test
 * genuinely exercises the bypass (not an unauthenticated app):
 *   - POST /threadline/secrets/request with NO bearer → 201 (keystone works)
 *   - POST /secrets/request with NO bearer → 401 (the gated path that drove the
 *     keystone's existence — proves the bypass is real, not an artifact)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

const SERVER_TOKEN = 'real-server-side-token-not-on-disk';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  // The REAL auth middleware, configured with a token the caller does NOT have
  // (mirrors the MCP process, which only sees {secret:true} on disk).
  app.use(authMiddleware(() => SERVER_TOKEN, 'test-agent'));
  const ctx: any = {
    config: { projectName: 'test-agent', authToken: SERVER_TOKEN, stateDir: '/tmp', port: 4042 },
    tunnel: null,
    stateDir: '/tmp',
  };
  app.use(createRoutes(ctx));
  return app;
}

async function listen(app: express.Express): Promise<TestServer> {
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

describe('Sealed-handoff keystone — POST /threadline/secrets/request (loopback self-mint)', () => {
  let server: TestServer;
  beforeEach(async () => { server = await listen(buildApp()); });
  afterEach(async () => { await server.close(); });

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(server.url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json as any };
  }

  it('MINTS a one-time URL with NO bearer (the keystone truth)', async () => {
    const r = await post('/threadline/secrets/request', { label: 'OpenAI API Key' });
    expect(r.status).toBe(201);
    expect(typeof r.body.token).toBe('string');
    expect(r.body.token.length).toBeGreaterThan(20);
    expect(r.body.localUrl).toBe(`/secrets/drop/${r.body.token}`);
    expect(r.body.expiresIn).toBe(15 * 60 * 1000);
    // It is a REQUEST, not a submission — no secret value is present anywhere.
    expect(JSON.stringify(r.body)).not.toMatch(/value|secret"\s*:/i);
  });

  it('the gated /secrets/request STILL 401s with no bearer (proves the bypass is real, not an unauthenticated app)', async () => {
    const r = await post('/secrets/request', { label: 'OpenAI API Key' });
    expect(r.status).toBe(401);
  });

  it('rejects a forwarded (X-Forwarded-For) request with 403 — defense-in-depth against a tunnel/bind misconfig', async () => {
    const r = await post('/threadline/secrets/request', { label: 'k' }, { 'X-Forwarded-For': '203.0.113.7' });
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toMatch(/forwarded/i);
  });

  it('validates the body — missing label → 400', async () => {
    const r = await post('/threadline/secrets/request', { description: 'no label' });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/label/);
  });

  it('accepts a valid R1a senderVerification pin', async () => {
    const r = await post('/threadline/secrets/request', {
      label: 'Stripe key',
      senderVerification: { senderPubKeyHex: 'a'.repeat(64) },
    });
    expect(r.status).toBe(201);
    expect(typeof r.body.token).toBe('string');
  });

  it('rejects a malformed senderVerification pin → 400', async () => {
    const r = await post('/threadline/secrets/request', {
      label: 'Stripe key',
      senderVerification: { senderPubKeyHex: 'not-hex' },
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/senderPubKeyHex/);
  });

  it('honors ttl bounds (reject < 1 min) shared with the gated path', async () => {
    const r = await post('/threadline/secrets/request', { label: 'k', ttlMs: 1000 });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/ttlMs/);
  });
});
