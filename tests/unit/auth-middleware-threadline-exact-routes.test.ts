/**
 * authMiddleware — /threadline/* is NOT a public prefix (fb-829a7161-942).
 *
 * Until 2026-10-27 the bearer gate let every `/threadline/*` path through, so
 * an unauthenticated POST over the public tunnel reached
 * `/threadline/relay-send`'s field validation: anyone holding the tunnel URL
 * could send Threadline messages under the agent's identity. The gate now
 * exempts ONLY the peer-protocol routes, by exact (method, path).
 *
 * These tests drive the real middleware with a configured token and a
 * tunnel-shaped request (Cf-Connecting-Ip set, non-loopback socket) — the
 * exact shape of the report — and assert both sides of every route class.
 */
import { describe, it, expect } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { authMiddleware, isThreadlinePublicRoute, THREADLINE_PUBLIC_ROUTES } from '../../src/server/middleware.js';

const TOKEN = 'agent-bearer-token-for-tests';

function tunnelReq(opts: { path: string; method?: string; auth?: string }): Request {
  const headers: Record<string, unknown> = { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7' };
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
  return {
    path: opts.path,
    method: opts.method ?? 'POST',
    headers,
    query: {},
    socket: { remoteAddress: '::ffff:172.16.0.9' },
  } as unknown as Request;
}

function mockRes(): Response & { statusCode: number; body: unknown } {
  const res = { statusCode: 0, body: undefined } as Response & { statusCode: number; body: unknown };
  res.status = ((n: number) => { res.statusCode = n; return res; }) as Response['status'];
  res.json = ((b: unknown) => { res.body = b; return res; }) as Response['json'];
  return res;
}

function run(req: Request): { nexted: boolean; status: number } {
  const mw = authMiddleware(() => TOKEN, 'test-agent');
  const res = mockRes();
  let nexted = false;
  const next: NextFunction = () => { nexted = true; };
  mw(req, res, next);
  return { nexted, status: res.statusCode };
}

/** Own-control-surface routes: sending, discovering, binding, config, private reads. */
const OWN_SURFACE: Array<[string, string]> = [
  ['POST', '/threadline/relay-send'],
  ['POST', '/threadline/relay-discover'],
  ['GET', '/threadline/status'],
  ['POST', '/threadline/hub/bind'],
  ['GET', '/threadline/telegram-bridge/config'],
  ['PATCH', '/threadline/telegram-bridge/config'],
  ['GET', '/threadline/observability/threads'],
  ['GET', '/threadline/observability/threads/abc'],
  ['GET', '/threadline/observability/search'],
  ['GET', '/threadline/conversations'],
  ['GET', '/threadline/peers/health'],
  ['GET', '/threadline/peers/0123456789abcdef/health'],
  ['GET', '/threadline/negotiator'],
  ['GET', '/threadline/pairing'],
  ['GET', '/threadline/pairing/enable'],
  ['POST', '/threadline/pairing/enable'],
  ['POST', '/threadline/pairing/invites'],
  ['GET', '/threadline/pairing/invites'],
  ['POST', '/threadline/pairing/invites/inspect'],
  ['POST', '/threadline/pairing/invites/00112233445566778899aabbccddeeff/approve'],
  ['DELETE', '/threadline/pairing/invites/00112233445566778899aabbccddeeff'],
  ['POST', '/threadline/pairing/00112233445566778899aabbccddeeff/start'],
  ['POST', '/threadline/pairing/00112233445566778899aabbccddeeff/verify'],
  ['GET', '/threadline/threads/thr_abc'],
  ['GET', '/threadline/threads/thr_abc/health'],
];

describe('authMiddleware — /threadline own-surface routes require the bearer', () => {
  for (const [method, path] of OWN_SURFACE) {
    it(`${method} ${path}: a tunnel request WITHOUT a token is refused (401), never reaches the handler`, () => {
      const r = run(tunnelReq({ method, path }));
      expect(r.nexted).toBe(false);
      expect(r.status).toBe(401);
    });
    it(`${method} ${path}: the same tunnel request WITH the agent token passes the gate`, () => {
      const r = run(tunnelReq({ method, path, auth: TOKEN }));
      expect(r.nexted).toBe(true);
    });
  }

  it('a wrong token on relay-send is refused (403), not passed', () => {
    const r = run(tunnelReq({ method: 'POST', path: '/threadline/relay-send', auth: 'not-the-token' }));
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });
});

describe('authMiddleware — peer-protocol /threadline routes stay public by EXACT route', () => {
  for (const { method, path } of THREADLINE_PUBLIC_ROUTES) {
    it(`${method} ${path} passes without a bearer (handler enforces its own auth)`, () => {
      const r = run(tunnelReq({ method, path }));
      expect(r.nexted).toBe(true);
    });
  }

  it('GET /threadline/blobs/:id passes without a bearer (one segment only)', () => {
    expect(run(tunnelReq({ method: 'GET', path: '/threadline/blobs/blob_1' })).nexted).toBe(true);
    expect(run(tunnelReq({ method: 'GET', path: '/threadline/blobs/blob_1/extra' })).nexted).toBe(false);
    expect(run(tunnelReq({ method: 'POST', path: '/threadline/blobs/blob_1' })).nexted).toBe(false);
  });

  it('the exemption is exact: a different METHOD on a public path is gated', () => {
    // health is public for GET only; a POST to it is not a discovery probe.
    expect(run(tunnelReq({ method: 'POST', path: '/threadline/health' })).nexted).toBe(false);
    expect(run(tunnelReq({ method: 'GET', path: '/threadline/handshake/hello' })).nexted).toBe(false);
  });

  it('the exemption is exact: prefix / suffix look-alikes are gated', () => {
    for (const path of [
      '/threadline/healthz',
      '/threadline/health/relay-send',
      '/threadline/handshake/hello/x',
      '/threadline/messages/receive/',
      '/threadline/',
      '/threadline',
      '/threadlinex/health',
    ]) {
      expect(run(tunnelReq({ method: 'GET', path })).nexted, path).toBe(false);
      expect(run(tunnelReq({ method: 'POST', path })).nexted, path).toBe(false);
    }
  });

  it('isThreadlinePublicRoute is case-insensitive on method, exact on path', () => {
    expect(isThreadlinePublicRoute('get', '/threadline/health')).toBe(true);
    expect(isThreadlinePublicRoute('GET', '/threadline/Health')).toBe(false);
    expect(isThreadlinePublicRoute('POST', '/threadline/relay-send')).toBe(false);
  });

  it('the public set is the six documented peer-protocol routes — nothing else', () => {
    expect(THREADLINE_PUBLIC_ROUTES.map(r => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /threadline/health',
      'POST /threadline/handshake/confirm',
      'POST /threadline/handshake/hello',
      'POST /threadline/messages/receive',
      'POST /threadline/secrets/request',
      'POST /threadline/threads/backfill',
    ]);
  });
});
