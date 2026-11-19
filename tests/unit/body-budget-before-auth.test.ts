/**
 * SEC-103: an unproven caller cannot make the server read a large body before the auth gate.
 * Real Express app on a real socket, the real auth middleware and error handler behind the parser.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  credentialAwareJsonParser,
  presentsCredential,
  isPeerBodyRoute,
  UNPROVEN_BODY_LIMIT_BYTES,
  type BodyBudgetDeps,
} from '../../src/server/bodyBudget.js';
import { authMiddleware, errorHandler } from '../../src/server/middleware.js';

const TOKEN = 'agent-token-0123456789';
let parsedBytes = 0;
let server: http.Server;
let base: string;

const deps: BodyBudgetDeps = {
  authToken: () => TOKEN,
  dashboardSessionValid: (t) => t === 'dst_good',
  memorySessionValid: (t) => t === 'mps_good',
  activeDevice: (id) => id === 'dev-active',
  activeMachine: (id) => id === 'm_active' || id === 'm_self',
  selfMachineId: () => 'm_self',
  verify: (_req, _res, buf) => { parsedBytes += buf.length; },
};

beforeAll(async () => {
  const app = express();
  // A per-path parser with its own full limit, ahead of the general one (as /mobile/org/recover).
  app.use('/recover', credentialAwareJsonParser(deps, 200 * 1024));
  app.post('/recover', (req, res) => { res.json({ got: JSON.stringify(req.body).length }); });
  app.use(credentialAwareJsonParser(deps));
  // A pre-auth public route that authenticates inside its handler.
  app.post('/mesh/rpc', (req, res) => { res.json({ got: JSON.stringify(req.body).length }); });
  app.post('/secrets/drop/:token', (req, res) => { res.json({ got: JSON.stringify(req.body).length }); });
  app.post('/dashboard/unlock', (req, res) => { res.json({ got: JSON.stringify(req.body).length }); });
  app.use(authMiddleware(() => TOKEN));
  app.post('/echo', (req, res) => { res.json({ got: JSON.stringify(req.body).length }); });
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

function bigJson(bytes: number): string {
  return JSON.stringify({ pad: 'x'.repeat(bytes) });
}

async function post(path: string, body: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('SEC-103 body budget before auth', () => {
  /** Sends only the headers (declaring a large body) and waits for the answer: proves nothing was read. */
  function headersOnly(path: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const u = new URL(base + path);
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024), ...headers } }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => { req.destroy(); resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }); });
      });
      req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e); });
      req.flushHeaders();
    });
  }

  it('refuses a declared large body from a stranger with 413 before reading a byte', async () => {
    parsedBytes = 0;
    const r = await headersOnly('/echo', {});
    expect(r.status).toBe(413);
    expect(r.body).toEqual({ error: 'body-too-large' });
    expect(parsedBytes).toBe(0);
  });

  it('refuses a declared large body with a wrong token the same way', async () => {
    const r = await headersOnly('/echo', { authorization: 'Bearer wrong-token' });
    expect(r.status).toBe(413);
  });

  it('refuses an unknown device id the same way', async () => {
    const r = await headersOnly('/echo', { 'x-instar-device': 'dev-unknown' });
    expect(r.status).toBe(413);
  });

  it('a small body from a stranger still reaches the auth gate and gets its 401', async () => {
    const r = await post('/echo', bigJson(100));
    expect(r.status).toBe(401);
  });

  it('a small body just under the budget is parsed for a pre-auth public route', async () => {
    const r = await post('/dashboard/unlock', bigJson(UNPROVEN_BODY_LIMIT_BYTES - 100));
    expect(r.status).toBe(200);
  });

  it('the agent token keeps the full budget', async () => {
    const r = await post('/echo', bigJson(2 * 1024 * 1024), { authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(200);
    expect(r.body.got).toBeGreaterThan(2 * 1024 * 1024);
  });

  it('a public peer route gets the 2 MB peer budget, never the full one', async () => {
    const r = await post('/mesh/rpc', bigJson(900 * 1024));
    expect(r.status).toBe(200);
    const over = await headersOnly('/mesh/rpc', { 'content-length': String(3 * 1024 * 1024) });
    expect(over.status).toBe(413);
  });

  it('a public route whose token is in the url gets only the small budget', async () => {
    const r = await post('/secrets/drop/anything', bigJson(UNPROVEN_BODY_LIMIT_BYTES + 1024));
    expect(r.status).toBe(413);
  });

  it('a stranger body with no declared length stops at the budget with 413', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(base + '/echo');
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.write('{"pad":"');
      req.end('y'.repeat(UNPROVEN_BODY_LIMIT_BYTES * 2) + '"}');
    });
    expect(status).toBe(413);
  });

  it('malformed JSON is a plain 400, not a 500', async () => {
    const r = await post('/echo', '{"broken":', { authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'invalid-json' });
  });

  it('malformed JSON from a stranger is a plain 400 too', async () => {
    const r = await post('/dashboard/unlock', '{nope');
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'invalid-json' });
  });
});

describe('per-path full limit', () => {
  it('an active device gets the route limit; a stranger gets the small budget', async () => {
    const signed = { 'x-instar-device': 'dev-active', 'x-instar-device-sig': 'sig', 'x-instar-device-time': String(Date.now()) };
    const ok = await post('/recover', bigJson(150 * 1024), signed);
    expect(ok.status).toBe(200);
    const stranger = await post('/recover', bigJson(150 * 1024));
    expect(stranger.status).toBe(413);
    const over = await post('/recover', bigJson(250 * 1024), signed);
    expect(over.status).toBe(413);
    expect(over.body).toEqual({ error: 'body-too-large' });
  });
});

describe('presentsCredential', () => {
  const NOW = 1_800_000_000_000;
  const at = { ...deps, now: () => NOW };
  const req = (headers: Record<string, string>, path = '/echo') => ({ headers, path }) as unknown as express.Request;
  const dev = (over: Record<string, string> = {}) => ({ 'x-instar-device': 'dev-active', 'x-instar-device-sig': 's', 'x-instar-device-time': String(NOW), ...over });
  const mach = (over: Record<string, string> = {}) => ({ 'x-machine-id': 'm_active', 'x-timestamp': String(NOW / 1000), 'x-nonce': 'n', 'x-sequence': '1', 'x-signature': 's', ...over });
  it('tokens: each kind and its near miss', () => {
    expect(presentsCredential(req({ authorization: `Bearer ${TOKEN}` }), at)).toBe(true);
    expect(presentsCredential(req({ authorization: `Bearer ${TOKEN}x` }), at)).toBe(false);
    expect(presentsCredential(req({ authorization: 'Bearer dst_good' }), at)).toBe(true);
    expect(presentsCredential(req({ authorization: 'Bearer dst_bad' }), at)).toBe(false);
    expect(presentsCredential(req({ authorization: 'Bearer mps_good' }), at)).toBe(true);
    expect(presentsCredential(req({ authorization: 'Bearer mps_bad' }), at)).toBe(false);
    expect(presentsCredential(req({}), at)).toBe(false);
  });
  it('a device needs an active id, its signature header and a fresh time', () => {
    expect(presentsCredential(req(dev()), at)).toBe(true);
    expect(presentsCredential(req({ 'x-instar-device': 'dev-active' }), at)).toBe(false);
    expect(presentsCredential(req(dev({ 'x-instar-device': 'dev-unknown' })), at)).toBe(false);
    expect(presentsCredential(req(dev({ 'x-instar-device-time': String(NOW - 10 * 60_000) })), at)).toBe(false);
    expect(presentsCredential(req(dev(), '/internal/x'), at)).toBe(false);
  });
  it('a machine needs the full header set, a fresh time, a machine route, and not our own id', () => {
    expect(presentsCredential(req(mach(), '/api/documents/push'), at)).toBe(true);
    expect(presentsCredential(req(mach(), '/echo'), at)).toBe(false);
    expect(presentsCredential(req({ 'x-machine-id': 'm_active' }, '/api/documents/push'), at)).toBe(false);
    expect(presentsCredential(req(mach({ 'x-timestamp': String(NOW / 1000 - 600) }), '/api/documents/push'), at)).toBe(false);
    expect(presentsCredential(req(mach({ 'x-machine-id': 'm_self' }), '/api/documents/push'), at)).toBe(false);
    expect(presentsCredential(req(mach({ 'x-machine-id': 'm_unknown' }), '/api/documents/push'), at)).toBe(false);
  });
});

describe('isPeerBodyRoute', () => {
  it('names exact peer routes, POST/PUT only', () => {
    expect(isPeerBodyRoute('POST', '/mesh/rpc')).toBe(true);
    expect(isPeerBodyRoute('POST', '/a2a/inbox')).toBe(true);
    expect(isPeerBodyRoute('GET', '/mesh/rpc')).toBe(false);
    expect(isPeerBodyRoute('POST', '/mesh/rpc/extra')).toBe(false);
    expect(isPeerBodyRoute('POST', '/api/messages/relay-machine')).toBe(false);
    expect(isPeerBodyRoute('POST', '/secrets/drop/x')).toBe(false);
    expect(isPeerBodyRoute('POST', '/sessions/spawn')).toBe(false);
  });
});
