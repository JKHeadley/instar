/**
 * Unit — FeatureActionApplier (spec feature-transition-applies-action §2.1).
 * Real local HTTP server; checks the outcome mapping and that only the static
 * action (never caller input) shapes the request.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { applyFeatureAction, loopbackHost } from '../../src/core/FeatureActionApplier.js';

let server: http.Server;
let port: number;
const seen: Array<{ method?: string; url?: string; auth?: string; csrf?: string; body: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, csrf: req.headers['x-instar-request'] as string, body });
      // The allowlisted paths double as scenario selectors via the body.
      const want = (() => { try { return JSON.parse(body).scenario; } catch { return undefined; } })();
      if (want === 'refuse') { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"Cannot patch these config keys via API: nope"}'); return; }
      if (want === 'refuse-obj') { res.writeHead(422, { 'content-type': 'application/json' }); res.end('{"error":{"code":"X","message":"object-shaped refusal"}}'); return; }
      if (want === 'boom') { res.writeHead(500); res.end('kaput'); return; }
      if (want === 'redirect') { res.writeHead(302, { location: '/elsewhere' }); res.end(); return; }
      if (want === 'hang') { return; } // never answers
      if (want === 'missing') { res.writeHead(404); res.end('{"error":"Not found"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"success":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });

const target = (over: Partial<{ timeoutMs: number; authToken: string }> = {}) => ({ host: '127.0.0.1', port, authToken: 'tok', ...over });

describe('applyFeatureAction', () => {
  it('2xx → applied, and sends exactly the static method/path/body with the server token and CSRF header', async () => {
    const r = await applyFeatureAction({ method: 'PATCH', path: '/config', body: { publishing: { enabled: true } } }, 'enable', target());
    expect(r).toMatchObject({ direction: 'enable', outcome: 'applied', httpStatus: 200, detail: null });
    const last = seen[seen.length - 1];
    expect(last.method).toBe('PATCH');
    expect(last.url).toBe('/config');
    expect(last.auth).toBe('Bearer tok');
    expect(last.csrf).toBe('1');
    expect(JSON.parse(last.body)).toEqual({ publishing: { enabled: true } });
  });

  it('4xx → refused with the route\'s own reason (string or object error)', async () => {
    const a = await applyFeatureAction({ method: 'PATCH', path: '/config', body: { scenario: 'refuse' } }, 'disable', target());
    expect(a).toMatchObject({ outcome: 'refused', httpStatus: 400, detail: 'Cannot patch these config keys via API: nope' });
    const b = await applyFeatureAction({ method: 'POST', path: '/telemetry/enable', body: { scenario: 'refuse-obj' } }, 'enable', target());
    expect(b).toMatchObject({ outcome: 'refused', httpStatus: 422, detail: 'object-shaped refusal' });
    const c = await applyFeatureAction({ method: 'PATCH', path: '/api/files/config', body: { scenario: 'missing' } }, 'enable', target());
    expect(c).toMatchObject({ outcome: 'refused', httpStatus: 404 });
  });

  it('5xx → failed; timeout → failed with no status; connection refused → failed', async () => {
    expect(await applyFeatureAction({ method: 'PATCH', path: '/config', body: { scenario: 'boom' } }, 'enable', target())).toMatchObject({ outcome: 'failed', httpStatus: 500, detail: 'kaput' });
    expect(await applyFeatureAction({ method: 'PATCH', path: '/config', body: { scenario: 'redirect' } }, 'enable', target())).toMatchObject({ outcome: 'failed', httpStatus: 302 });
    expect(await applyFeatureAction({ method: 'PATCH', path: '/config', body: { scenario: 'hang' } }, 'enable', target({ timeoutMs: 200 }))).toMatchObject({ outcome: 'failed', httpStatus: null });
    expect((await applyFeatureAction({ method: 'PATCH', path: '/config', body: { scenario: 'hang' } }, 'enable', target({ timeoutMs: 200 }))).detail).toMatch(/timed out; it may still land/);
    const dead = await applyFeatureAction({ method: 'PATCH', path: '/config', body: {} }, 'enable', { host: '127.0.0.1', port: 1, authToken: 'tok' });
    expect(dead.outcome).toBe('failed');
    expect(dead.httpStatus).toBeNull();
  });

  it('sends ONLY the four allowlisted method/path pairs, and nothing without a token (not-applied, never sent)', async () => {
    const before = seen.length;
    expect((await applyFeatureAction(undefined, 'enable', target())).outcome).toBe('not-applied');
    expect((await applyFeatureAction({ method: 'DELETE' as never, path: '/config', body: {} }, 'enable', target())).outcome).toBe('not-applied');
    expect((await applyFeatureAction({ method: 'POST', path: '/config', body: {} }, 'enable', target())).outcome).toBe('not-applied');
    expect((await applyFeatureAction({ method: 'PATCH', path: '/sessions/spawn', body: {} }, 'enable', target())).outcome).toBe('not-applied');
    expect((await applyFeatureAction({ method: 'PATCH', path: '//evil.example/config', body: {} }, 'enable', target())).outcome).toBe('not-applied');
    expect((await applyFeatureAction({ method: 'PATCH', path: '/config', body: {} }, 'enable', target({ authToken: '' }))).outcome).toBe('not-applied');
    expect(seen.length).toBe(before);
  });

  it('every built-in feature action is on the allowlist (a definition can never name a path the client will not send)', async () => {
    const { BUILTIN_FEATURES } = await import('../../src/core/FeatureDefinitions.js');
    const { ALLOWED_FEATURE_ACTIONS } = await import('../../src/core/FeatureActionApplier.js');
    for (const d of BUILTIN_FEATURES) {
      for (const a of [d.enableAction, d.disableAction]) expect(ALLOWED_FEATURE_ACTIONS.has(`${a.method} ${a.path}`), `${d.id}: ${a.method} ${a.path}`).toBe(true);
    }
  });
});

describe('loopbackHost', () => {
  it('maps wildcard and mapped addresses to dialable loopback', () => {
    expect(loopbackHost(undefined)).toBe('127.0.0.1');
    expect(loopbackHost('0.0.0.0')).toBe('127.0.0.1');
    expect(loopbackHost('::')).toBe('::1');
    expect(loopbackHost('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(loopbackHost('100.64.1.2')).toBe('100.64.1.2');
  });
});
