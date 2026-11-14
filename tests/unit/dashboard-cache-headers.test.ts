/**
 * #1441 — dashboard static assets must never outlive a release (unit tier).
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

describe('#1441 dashboardCacheControl — pages revalidate, scripts and styles are never stored', () => {
  it('stamps no-cache on pages (and when no path is known), keeping 304 revalidation', () => {
    for (const p of [undefined, '/x/dashboard/index.html', '/x/dashboard/console/index.html', '/x/dashboard/logo.png']) {
      const { res, headers } = mockRes();
      dashboardCacheControl(res, p);
      expect(headers['Cache-Control'], String(p)).toBe('no-cache');
    }
  });

  it('stamps no-store on .js, .mjs and .css — the only directive Cloudflare passes through for them', () => {
    // Measured 2026-10-30 via the named tunnel: Cloudflare rewrote `no-cache` on .js/.css
    // to max-age=14400 (a release then reached the phone up to 4h late) and passed
    // `no-store` through untouched.
    for (const p of ['/x/dashboard/glance.js', '/x/dashboard/console/console.css', '/x/dashboard/a.mjs', '/x/dashboard/STYLE.CSS']) {
      const { res, headers } = mockRes();
      dashboardCacheControl(res, p);
      expect(headers['Cache-Control'], p).toBe('no-store');
    }
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

  it('setHeaders uses the served path: no-store for a module, no-cache for a page', () => {
    // serve-static calls setHeaders(res, path, stat) after it would set its own Cache-Control.
    const set = DASHBOARD_STATIC_OPTIONS.setHeaders as (r: Response, p: string) => void;
    const a = mockRes(); set(a.res, '/x/dashboard/glance.js'); expect(a.headers['Cache-Control']).toBe('no-store');
    const b = mockRes(); set(b.res, '/x/dashboard/index.html'); expect(b.headers['Cache-Control']).toBe('no-cache');
  });
});
