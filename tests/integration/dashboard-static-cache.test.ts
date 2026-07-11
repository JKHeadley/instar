/**
 * #1441 — dashboard static-asset cache headers (integration tier).
 *
 * Boots a REAL Express server serving the REAL dashboard/ directory with the exact
 * shipped {@link DASHBOARD_STATIC_OPTIONS} + index-route wiring the AgentServer uses,
 * and asserts over HTTP that:
 *   - /dashboard/glance.js is served `Cache-Control: no-cache` with an ETag,
 *   - an If-None-Match re-request 304s (revalidation works — the file that broke in
 *     the wild is the one exercised here),
 *   - the transitively-imported subscriptions.js is no-cache too (a version query
 *     param on glance.js alone would NOT cover it — the header approach does),
 *   - the /dashboard index.html route is also no-cache (fresh index each load).
 * This is the deploy-skew kill: every asset revalidates each load, so a fresh
 * index.html can no longer pair with a stale glance.js.
 *
 * Uses node:http (not undici `fetch`, which swallows 304 status codes on localhost).
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { dashboardCacheControl, DASHBOARD_STATIC_OPTIONS } from '../../src/server/middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.resolve(__dirname, '..', '..', 'dashboard');

interface TestServer { url: string; close: () => Promise<void>; }
function boot(): Promise<TestServer> {
  const app = express();
  // Mirror AgentServer.setupRoutes wiring exactly.
  app.get('/dashboard', (_req, res) => {
    dashboardCacheControl(res);
    res.sendFile(path.join(DASHBOARD_DIR, 'index.html'), { cacheControl: false, etag: true, lastModified: true });
  });
  app.use('/dashboard', express.static(DASHBOARD_DIR, DASHBOARD_STATIC_OPTIONS));
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string; }
function get(base: string, p: string, headers: Record<string, string> = {}): Promise<Resp> {
  const u = new URL(p, base);
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

let server: TestServer | null = null;
afterEach(async () => { if (server) { await server.close(); server = null; } });

describe('#1441 dashboard static asset serving', () => {
  it('serves glance.js with Cache-Control: no-cache and an ETag', async () => {
    server = await boot();
    const res = await get(server.url, '/dashboard/glance.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers.etag).toBeTruthy();
    // The default `public, max-age=0` (which Cloudflare overrode to 4h) is gone.
    expect(res.headers['cache-control']).not.toContain('max-age');
  });

  it('304s on If-None-Match — the browser revalidates instead of using a stale copy', async () => {
    server = await boot();
    const first = await get(server.url, '/dashboard/glance.js');
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBeTruthy();
    const second = await get(server.url, '/dashboard/glance.js', { 'If-None-Match': first.headers.etag as string });
    expect(second.status).toBe(304);
  });

  it('serves the transitively-imported subscriptions.js with no-cache too', async () => {
    // glance.js imports ./subscriptions.js — a version query param on glance.js alone
    // would NOT bust this. The header approach covers every module transitively.
    server = await boot();
    const res = await get(server.url, '/dashboard/subscriptions.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('serves the /dashboard index.html route with no-cache (fresh index each load)', async () => {
    server = await boot();
    const res = await get(server.url, '/dashboard');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body.slice(0, 200).toLowerCase()).toContain('<!doctype html>');
  });
});
