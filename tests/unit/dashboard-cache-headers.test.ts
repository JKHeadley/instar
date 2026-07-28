/**
 * #1441 — dashboard static assets must revalidate every load (unit tier).
 *
 * Before this fix, express.static served `Cache-Control: public, max-age=0`, which
 * Cloudflare's edge overrode with a multi-hour TTL; a warm-cache browser then paired
 * a fresh index.html with a stale glance.js and threw
 * `glance.blockersGlanceSpec is not a function`, blanking a whole tab for up to 4h
 * after each phase deploy. These tests pin the shared header helper the AgentServer
 * wiring uses, so a regression here (or a drift in the static options) fails the build.
 */
import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import { dashboardCacheControl, DASHBOARD_STATIC_OPTIONS } from '../../src/server/middleware.js';

/** A minimal Response stub that records setHeader calls. */
function mockRes(): { res: Response; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res = {
    setHeader(name: string, value: string) { headers[name] = value; return res; },
    header(name: string, value: string) { headers[name] = value; return res; },
  } as unknown as Response;
  return { res, headers };
}

describe('#1441 dashboardCacheControl — revalidate-always header', () => {
  it('stamps Cache-Control: no-cache (revalidate, not no-store)', () => {
    const { res, headers } = mockRes();
    dashboardCacheControl(res);
    expect(headers['Cache-Control']).toBe('no-cache');
  });

  it('is no-cache, NOT no-store — keeps 304 revalidation efficient', () => {
    const { res, headers } = mockRes();
    dashboardCacheControl(res);
    // no-store would kill ETag 304s and re-download every asset every load; the fix
    // deliberately uses no-cache so unchanged assets 304 instead.
    expect(headers['Cache-Control']).not.toContain('no-store');
  });
});

describe('#1441 DASHBOARD_STATIC_OPTIONS — the wiring contract', () => {
  it('routes setHeaders through the same helper (no drift between wiring and test)', () => {
    expect(DASHBOARD_STATIC_OPTIONS.setHeaders).toBe(dashboardCacheControl);
  });

  it('keeps etag + lastModified on so revalidation works', () => {
    expect(DASHBOARD_STATIC_OPTIONS.etag).toBe(true);
    expect(DASHBOARD_STATIC_OPTIONS.lastModified).toBe(true);
  });

  it('setHeaders applied to a served response yields no-cache', () => {
    const { res, headers } = mockRes();
    // serve-static calls setHeaders(res, path, stat) after it would set its own
    // Cache-Control; our helper overrides it to no-cache.
    (DASHBOARD_STATIC_OPTIONS.setHeaders as (r: Response) => void)(res);
    expect(headers['Cache-Control']).toBe('no-cache');
  });
});
