/**
 * Console makeover (docs/specs/console-makeover.md, Access + MVP 5) — integration tier.
 *
 * Boots a real Express app with the exact dashboard wiring AgentServer uses
 * (security headers → /dashboard index route → static mount) over the REAL
 * dashboard/ directory, and asserts the console is served beside the legacy
 * dashboard with the same headers: framing stays DENY (the plan dropped
 * embedding), every asset revalidates, fonts load from 'self', and the legacy
 * page links to the console.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { dashboardCacheControl, dashboardSecurityHeaders, DASHBOARD_STATIC_OPTIONS } from '../../src/server/middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.resolve(__dirname, '..', '..', 'dashboard');

interface TestServer { url: string; close: () => Promise<void>; }
function boot(): Promise<TestServer> {
  const app = express();
  app.use(dashboardSecurityHeaders);
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
function get(base: string, p: string): Promise<Resp> {
  const u = new URL(p, base);
  return new Promise((resolve, reject) => {
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let body = '';
      res.setEncoding('latin1');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    }).on('error', reject);
  });
}

let server: TestServer | null = null;
afterEach(async () => { if (server) { await server.close(); server = null; } });

describe('console served beside the legacy dashboard', () => {
  it('GET /dashboard/console/ serves the console page with the dashboard headers', async () => {
    server = await boot();
    const res = await get(server.url, '/dashboard/console/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>Instar console</title>');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('GET /dashboard/console redirects to the trailing-slash page', async () => {
    server = await boot();
    const res = await get(server.url, '/dashboard/console');
    expect([301, 302, 308]).toContain(res.status);
    expect(res.headers.location).toBe('/dashboard/console/');
  });

  it('serves every console asset, revalidating, with the right types', async () => {
    server = await boot();
    for (const [p, type] of [
      ['/dashboard/console/console.css', 'text/css'],
      ['/dashboard/console/console.js', 'javascript'],
      ['/dashboard/console/home-model.js', 'javascript'],
      ['/dashboard/console/nav-model.js', 'javascript'],
      ['/dashboard/console/ui.js', 'javascript'],
      ['/dashboard/console/promises.js', 'javascript'],
      ['/dashboard/console/promises-model.js', 'javascript'],
      ['/dashboard/console/machines.js', 'javascript'],
      ['/dashboard/console/machines-model.js', 'javascript'],
      ['/dashboard/console/accounts.js', 'javascript'],
      ['/dashboard/console/accounts-model.js', 'javascript'],
      ['/dashboard/console/messages.js', 'javascript'],
      ['/dashboard/console/messages-model.js', 'javascript'],
      ['/dashboard/console/allowed.js', 'javascript'],
      ['/dashboard/console/allowed-model.js', 'javascript'],
      ['/dashboard/console/plans.js', 'javascript'],
      ['/dashboard/console/plans-model.js', 'javascript'],
      ['/dashboard/console/costs.js', 'javascript'],
      ['/dashboard/console/costs-model.js', 'javascript'],
      ['/dashboard/console/schedule.js', 'javascript'],
      ['/dashboard/console/schedule-model.js', 'javascript'],
      ['/dashboard/console/fonts/inter-latin-wght-normal.woff2', 'font/woff2'],
      ['/dashboard/console/fonts/jetbrains-mono-latin-wght-normal.woff2', 'font/woff2'],
    ] as const) {
      const res = await get(server.url, p);
      expect(res.status, p).toBe(200);
      expect(res.headers['content-type'], p).toContain(type);
      expect(res.headers['cache-control'], p).toBe('no-cache');
    }
  });

  it('the console never relaxes framing or embeds the legacy dashboard', async () => {
    server = await boot();
    const js = (await get(server.url, '/dashboard/console/console.js')).body;
    expect(js).not.toMatch(/<iframe|createElement\(['"]iframe/);
    expect(js).not.toContain('operatorSessionToken');
  });

  it('the legacy dashboard links to the console and keeps DENY', async () => {
    server = await boot();
    const res = await get(server.url, '/dashboard');
    expect(res.status).toBe(200);
    expect(res.body).toContain('href="/dashboard/console/"');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});
