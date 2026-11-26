/**
 * /dashboard opens the console; the legacy page and every ?tab= link keep working; the pairing code
 * page carries the strict policy on every URL that serves it
 * (docs/specs/dashboard-console-default-and-pair-page.md §3.1, §3.2, §3.5) — integration tier.
 *
 * Boots Express with AgentServer's order: security headers → entry routes → pair page → static
 * mount → a stand-in for the auth middleware (refuses everything that reaches it), over the REAL
 * dashboard/ and dashboard-pair/ folders.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { dashboardSecurityHeaders, DASHBOARD_STATIC_OPTIONS } from '../../src/server/middleware.js';
import { mountDashboardEntryRoutes, mountPairPage, PAIR_PAGE_CSP, dashboardEntryTarget } from '../../src/server/dashboardEntry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.resolve(__dirname, '..', '..', 'dashboard');
const PAIR_DIR = path.resolve(__dirname, '..', '..', 'dashboard-pair');
const PAIR_HTML = fs.readFileSync(path.join(PAIR_DIR, 'pair.html'), 'utf8');

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string; }
function get(base: string, rawPath: string): Promise<Resp> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    // rawPath is sent byte-for-byte (no URL normalisation), so encoded and odd spellings reach the server.
    http.get({ hostname: u.hostname, port: u.port, path: rawPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    }).on('error', reject);
  });
}

let base = '';
let close: () => Promise<void> = async () => {};
beforeAll(async () => {
  const app = express();
  app.use(dashboardSecurityHeaders);
  mountDashboardEntryRoutes(app, { dashboardDir: DASHBOARD_DIR });
  mountPairPage(app, { pairDir: PAIR_DIR });
  app.use('/dashboard', express.static(DASHBOARD_DIR, DASHBOARD_STATIC_OPTIONS));
  app.use((_req, res) => { res.status(401).json({ error: 'auth required' }); }); // stand-in for authMiddleware
  await new Promise<void>((resolve) => {
    const srv = app.listen(0, () => {
      base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      close = () => new Promise<void>((r) => srv.close(() => r()));
      resolve();
    });
  });
});
afterAll(async () => { await close(); });

describe('/dashboard opens the console; legacy stays reachable', () => {
  it.each(['/dashboard', '/dashboard/', '/DASHBOARD', '/Dashboard/'])('%s → 302 to the console, not cached', async (p) => {
    const r = await get(base, p);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/dashboard/console/');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['/dashboard?tab=files&path=.claude/CLAUDE.md', '/dashboard/legacy?tab=files&path=.claude/CLAUDE.md'],
    ['/dashboard?tab=phones', '/dashboard/legacy?tab=phones'],
    ['/dashboard/?ratify-deferral=136833', '/dashboard/legacy?ratify-deferral=136833'],
    ['/dashboard?tab=mandates&account=a%20b&target=m1', '/dashboard/legacy?tab=mandates&account=a%20b&target=m1'],
  ])('%s → legacy with the query intact', async (from, to) => {
    const r = await get(base, from);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(to);
  });

  it('an empty query string goes to the console; the target is always on this server', () => {
    expect(dashboardEntryTarget('/dashboard?')).toBe('/dashboard/console/');
    expect(dashboardEntryTarget('/dashboard?next=https://evil.example')).toBe('/dashboard/legacy?next=https://evil.example');
    expect(dashboardEntryTarget('/dashboard?//evil.example')).toMatch(/^\/dashboard\/legacy\?/);
  });

  it('/dashboard/legacy serves the legacy page with its usual headers', async () => {
    for (const [p, to] of [['/dashboard/legacy/', '/dashboard/legacy'], ['/dashboard/legacy/?tab=files&path=x', '/dashboard/legacy?tab=files&path=x']]) {
      const r = await get(base, p);
      expect(r.status).toBe(302); // one address, so relative URLs on the page resolve the same
      expect(r.headers.location).toBe(to);
    }
    for (const p of ['/dashboard/legacy', '/dashboard/legacy?tab=sessions']) {
      const r = await get(base, p);
      expect(r.status).toBe(200);
      expect(r.body).toContain('href="/dashboard/console/"'); // the legacy header's "Try the new console"
      expect(r.headers['cache-control']).toBe('no-cache');
      expect(r.headers['x-frame-options']).toBe('DENY');
    }
  });

  it('a capitalised legacy address still carries the dashboard security headers (no framing)', async () => {
    const r = await get(base, '/Dashboard/Legacy');
    expect(r.status).toBe(200);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['content-security-policy']).toBeTruthy();
  });

  it('the console itself is unchanged', async () => {
    const r = await get(base, '/dashboard/console/');
    expect(r.status).toBe(200);
    expect(r.body).toContain('console.js');
  });
});

describe('the pairing code page carries the strict policy wherever it is served', () => {
  const strict = (r: Resp) => {
    expect(r.headers['content-security-policy']).toBe(PAIR_PAGE_CSP);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cache-control']).toBe('no-store');
  };

  it('the policy allows only its own files: no inline script, nothing third-party, no framing', () => {
    expect(PAIR_PAGE_CSP).toContain("default-src 'none'");
    expect(PAIR_PAGE_CSP).toContain("script-src 'self'");
    expect(PAIR_PAGE_CSP).toContain("frame-ancestors 'none'");
    expect(PAIR_PAGE_CSP).not.toMatch(/unsafe-inline|unsafe-eval|jsdelivr|https?:/);
  });

  it.each(['/dashboard/pair', '/dashboard/pair/', '/Dashboard/PAIR', '/DASHBOARD/pair/'])('%s serves the page with all four strict headers', async (p) => {
    const r = await get(base, p);
    expect(r.status).toBe(200);
    expect(r.body).toBe(PAIR_HTML);
    strict(r);
  });

  it.each([
    ['/dashboard/pair.js', 'javascript'],
    ['/dashboard/pair-model.js', 'javascript'],
    ['/dashboard/pair.css', 'text/css'],
    ['/Dashboard/Pair.JS', 'javascript'],
  ])('%s is served strict, with its type', async (p, type) => {
    const r = await get(base, p);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain(type);
    strict(r);
  });

  it.each([
    '/dashboard/pair.html',
    '/dashboard/PAIR.HTML',
    '/dashboard/p%61ir',
    '/dashboard/%70air.js',
    '/dashboard/pair/x',
    '/dashboard/pair/pair.html',
    '/dashboard/console/../pair',
    '/dashboard/console/pair.html',
    '/dashboard/preview/pair',
    '/dashboard-pair/pair.html',
    '/dashboard/../dashboard-pair/pair.html',
    '/dashboard/%2e%2e/dashboard-pair/pair.html',
  ])('%s never serves the page without the strict policy', async (p) => {
    const r = await get(base, p);
    if (r.status === 200 && r.body.includes('id="pair-root"')) strict(r);
    else expect(r.body).not.toContain('id="pair-root"');
  });

  it('the page loads only its own files by absolute path, with no inline script or style', () => {
    expect(PAIR_HTML).toContain('<script type="module" src="/dashboard/pair.js"></script>');
    expect(PAIR_HTML).toContain('href="/dashboard/pair.css"');
    expect(PAIR_HTML).not.toMatch(/<script>(?!<\/script>)|<script(?![^>]*\bsrc=)[^>]*>|\son[a-z]+=|style=|https?:\/\//);
  });
});
