/**
 * Unit tests for the auth middleware's live-token resolution (PR 7 of the
 * tunnel-failure-resilience chain).
 *
 * Spec: specs/dev-infrastructure/tunnel-failure-resilience.md Part 6.
 *
 * authMiddleware now accepts a getter so the bearer token can be rotated
 * at runtime (tunnel credential rotation) and take effect IMMEDIATELY —
 * the security guarantee is that the moment rotation completes, the old
 * bearer token AND old HMAC-signed view URLs are rejected, without a
 * server restart. These tests assert both sides of that boundary.
 */

import { describe, it, expect } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { authMiddleware, signViewPath } from '../../src/server/middleware.js';

function mockReq(opts: { path?: string; method?: string; auth?: string; sig?: string }): Request {
  const headers: Record<string, unknown> = {};
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
  return {
    path: opts.path ?? '/status',
    method: opts.method ?? 'GET',
    headers,
    query: opts.sig ? { sig: opts.sig } : {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
}

function mockRes(): Response & { statusCode: number } {
  const res = { statusCode: 0 } as Response & { statusCode: number };
  res.status = ((n: number) => { res.statusCode = n; return res; }) as Response['status'];
  res.json = (() => res) as Response['json'];
  return res;
}

/** Run the middleware against a request; returns whether next() was called. */
function run(mw: ReturnType<typeof authMiddleware>, req: Request, res: Response): boolean {
  let nexted = false;
  const next: NextFunction = () => { nexted = true; };
  mw(req, res, next);
  return nexted;
}

describe('authMiddleware live-token resolution', () => {
  it('string form (back-compat): valid token passes, wrong token 403s', () => {
    const mw = authMiddleware('static-token');
    expect(run(mw, mockReq({ auth: 'static-token' }), mockRes())).toBe(true);

    const res = mockRes();
    expect(run(mw, mockReq({ auth: 'wrong' }), res)).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('getter form: resolves the token per request', () => {
    const mw = authMiddleware(() => 'tok-A');
    expect(run(mw, mockReq({ auth: 'tok-A' }), mockRes())).toBe(true);

    const res = mockRes();
    expect(run(mw, mockReq({ auth: 'nope' }), res)).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('ROTATION: the same middleware instance honors a token change immediately', () => {
    let token = 'tok-OLD';
    const mw = authMiddleware(() => token);

    // Before rotation: OLD passes.
    expect(run(mw, mockReq({ auth: 'tok-OLD' }), mockRes())).toBe(true);

    // Rotate the live token.
    token = 'tok-NEW';

    // After rotation: OLD is rejected, NEW passes — no new middleware, no restart.
    const resOld = mockRes();
    expect(run(mw, mockReq({ auth: 'tok-OLD' }), resOld)).toBe(false);
    expect(resOld.statusCode).toBe(403);
    expect(run(mw, mockReq({ auth: 'tok-NEW' }), mockRes())).toBe(true);
  });

  it('ROTATION invalidates previously-signed view URLs', () => {
    let token = 'tok-OLD';
    const mw = authMiddleware(() => token);
    const viewPath = '/view/abc123';
    const sig = signViewPath(viewPath, 'tok-OLD');

    // Old signed URL works while the token is current.
    expect(run(mw, mockReq({ path: viewPath, sig }), mockRes())).toBe(true);

    // After rotation, the HMAC no longer matches (verification uses the
    // live token) → the signed URL is rejected (falls through to the
    // bearer check, which 401s with no header).
    token = 'tok-NEW';
    const res = mockRes();
    expect(run(mw, mockReq({ path: viewPath, sig }), res)).toBe(false);
    expect(res.statusCode).toBe(401);

    // A URL signed with the NEW token works.
    const newSig = signViewPath(viewPath, 'tok-NEW');
    expect(run(mw, mockReq({ path: viewPath, sig: newSig }), mockRes())).toBe(true);
  });

  it('getter returning undefined → open (test/dev passthrough)', () => {
    const mw = authMiddleware(() => undefined);
    expect(run(mw, mockReq({ path: '/status' }), mockRes())).toBe(true);
  });

  // Dynamic-MCP operator-approval TAP pages are opened by the operator's browser,
  // which carries no Bearer token (it has the dashboard PIN). The page route must be
  // exempt from the bearer gate — the opaque requestId in the URL + the PIN on submit
  // are the auth. Regression: a live-as-self test found the browser got a 401 here
  // because the route was behind the bearer middleware (the integration tests bypass
  // the middleware, so they missed it).
  describe('dynamic-MCP approval tap-page bearer exemption', () => {
    const mw = authMiddleware('static-token');
    it('GET /mcp/approve/<requestId> is exempt (no Bearer → next())', () => {
      expect(run(mw, mockReq({ path: '/mcp/approve/abc123', method: 'GET' }), mockRes())).toBe(true);
    });
    it('POST /mcp/approve/<requestId> is exempt (browser form submit, no Bearer → next(); PIN-gated in handler)', () => {
      expect(run(mw, mockReq({ path: '/mcp/approve/abc123', method: 'POST' }), mockRes())).toBe(true);
    });
    it('the exact agent-only /mcp/approve (no requestId) stays Bearer-gated (401 without a token)', () => {
      const res = mockRes();
      expect(run(mw, mockReq({ path: '/mcp/approve', method: 'POST' }), res)).toBe(false);
      expect(res.statusCode).toBe(401);
    });
    it('/mcp/approval-link stays Bearer-gated (agent-only registration; 401 without a token)', () => {
      const res = mockRes();
      expect(run(mw, mockReq({ path: '/mcp/approval-link', method: 'POST' }), res)).toBe(false);
      expect(res.statusCode).toBe(401);
    });
    it('the agent data routes /mcp/load|offload|session stay Bearer-gated', () => {
      for (const p of ['/mcp/load', '/mcp/offload', '/mcp/session/5']) {
        const res = mockRes();
        expect(run(mw, mockReq({ path: p, method: 'POST' }), res)).toBe(false);
        expect(res.statusCode).toBe(401);
      }
    });
  });
});
