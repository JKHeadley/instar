/**
 * Project apps part 2, the sealed frame and the narrow key (docs/specs/project-apps-sandbox.md
 * §3.6-3.7): key mint/verify, the single-use ticket, the origin allow-list, the exact headers, the
 * exact auth/CORS exemptions, the wrapper's CSP branch, the wrapper's renewal rules, redaction.
 */
import { describe, it, expect } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  mintKey, verifyKey, TicketStore, resolveKnownOrigin, frameHeaders, frameCsp, wrapperCsp,
  isProjectAppPublicRoute, ProjectAppSandbox, KEY_TTL_MS, TICKET_TTL_MS, customProjectAppsEnabled,
} from '../../src/server/ProjectAppSandbox.js';
import { authMiddleware, corsMiddleware, dashboardSecurityHeaders } from '../../src/server/middleware.js';
import { Redactor } from '../../src/monitoring/Redactor.js';
import { CREDENTIAL_SHAPES } from '../../src/core/credentialShapes.js';
import {
  backoffDelay, renewDelay, acceptMessage, classifyKeyAnswer, safeConversationHref, BACKOFF_FLOOR_MS,
} from '../../dashboard/project-app/wrapper-model.js';
import { FakeCustomAppSource, sha } from '../helpers/fakeCustomAppSource.js';
import { TokenBuckets, API_RATE_DEFAULT } from '../../src/server/projectAppSandboxRoutes.js';

const SECRET = Buffer.alloc(32, 7);
const A = 'pa_0123456789abcdef';
const B = 'pa_fedcba9876543210';
const SHA1 = sha('<p>v1</p>');
const SHA2 = sha('<p>v2</p>');
const NOW = 1_800_000_000_000;

describe('narrow key — mint and verify', () => {
  const key = mintKey(SECRET, { appId: A, contentSha: SHA1, exp: NOW + KEY_TTL_MS, epoch: 3 });
  const want = { appId: A, right: 'data:write' as const, now: NOW, epoch: 3, servedSha: SHA1 };

  it('verifies for its own app, version, epoch and right', () => {
    const v = verifyKey(SECRET, key, want);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.claims.rights).toEqual(['data:read', 'data:write', 'summary:write']);
    expect(key.startsWith('pak_')).toBe(true);
  });
  it('refuses another app', () => { expect(verifyKey(SECRET, key, { ...want, appId: B })).toEqual({ ok: false, reason: 'wrong-app' }); });
  it('refuses when its version is no longer served', () => {
    expect(verifyKey(SECRET, key, { ...want, servedSha: SHA2 })).toEqual({ ok: false, reason: 'version-not-served' });
    expect(verifyKey(SECRET, key, { ...want, servedSha: null })).toEqual({ ok: false, reason: 'version-not-served' });
  });
  it('refuses at and after expiry, accepts just before', () => {
    expect(verifyKey(SECRET, key, { ...want, now: NOW + KEY_TTL_MS - 1 }).ok).toBe(true);
    expect(verifyKey(SECRET, key, { ...want, now: NOW + KEY_TTL_MS })).toEqual({ ok: false, reason: 'expired' });
  });
  it('refuses after an epoch bump', () => { expect(verifyKey(SECRET, key, { ...want, epoch: 4 })).toEqual({ ok: false, reason: 'revoked' }); });
  it('refuses a tampered payload, a tampered signature and another secret', () => {
    const [payload, sig] = key.slice(4).split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    claims.appId = B;
    const forged = `pak_${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
    expect(verifyKey(SECRET, forged, { ...want, appId: B })).toEqual({ ok: false, reason: 'bad-signature' });
    const flipped = `pak_${payload}.${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(verifyKey(SECRET, flipped, want)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifyKey(Buffer.alloc(32, 8), key, want)).toEqual({ ok: false, reason: 'bad-signature' });
  });
  it('refuses malformed keys and a missing right', () => {
    for (const bad of ['', 'pak_', 'pak_abc', `Bearer ${key}`, `${key}.x`, 'x'.repeat(3000)]) expect(verifyKey(SECRET, bad, want).ok).toBe(false);
    const readOnly = mintKey(SECRET, { appId: A, contentSha: SHA1, exp: NOW + 1000, epoch: 3, rights: ['data:read'] });
    expect(verifyKey(SECRET, readOnly, want)).toEqual({ ok: false, reason: 'no-right' });
  });
});

describe('ProjectAppSandbox — mint follows the served version', () => {
  const setup = () => {
    const src = new FakeCustomAppSource();
    const sha1 = src.add(A, '<p>v1</p>');
    let now = NOW;
    const sb = new ProjectAppSandbox({ source: src, hmacSecret: () => SECRET, now: () => now });
    return { src, sb, sha1, tick: (ms: number) => { now += ms; } };
  };
  it('mints for the loaded version and refuses a changed one (renewal is bound to the loaded hash)', () => {
    const { src, sb, sha1 } = setup();
    const r = sb.mint(A, sha1);
    expect(r.ok).toBe(true);
    const sha2 = src.serve(A, '<p>v2</p>');
    expect(sb.mint(A, sha1)).toMatchObject({ ok: false, status: 409, error: 'version-changed', contentSha: sha2 });
    if (r.ok) expect(sb.verify(A, r.key, 'data:read')).toMatchObject({ ok: false });
  });
  it('refuses while disabled or with no version, and with no secret', () => {
    const { src, sb, sha1 } = setup();
    src.disable(A);
    expect(sb.mint(A, sha1)).toMatchObject({ ok: false, status: 409, error: 'not-served', state: 'disabled' });
    expect(sb.mint(B, null)).toMatchObject({ ok: false, error: 'not-served', state: 'none' });
    const none = new ProjectAppSandbox({ source: new FakeCustomAppSource(), hmacSecret: () => null });
    expect(none.mint(A, null)).toMatchObject({ ok: false, status: 503 });
    const short = new ProjectAppSandbox({ source: new FakeCustomAppSource(), hmacSecret: () => Buffer.alloc(8) });
    expect(short.secret()).toBeNull();
  });
  it('a key expires 15 minutes after minting', () => {
    const { sb, sha1, tick } = setup();
    const r = sb.mint(A, sha1);
    if (!r.ok) throw new Error('mint');
    tick(KEY_TTL_MS - 1);
    expect(sb.verify(A, r.key, 'summary:write').ok).toBe(true);
    tick(1);
    expect(sb.verify(A, r.key, 'summary:write')).toMatchObject({ ok: false, reason: 'expired' });
  });
});

describe('frame ticket', () => {
  it('is single use, expires after 60 s, and is bound to the app and version', () => {
    let now = NOW;
    const ts = new TicketStore(() => now);
    const t1 = ts.issue(A, SHA1).ticket;
    expect(ts.consume(t1, A, SHA1)).toEqual({ ok: true });
    expect(ts.consume(t1, A, SHA1)).toEqual({ ok: false, reason: 'unknown' });

    const t2 = ts.issue(A, SHA1).ticket;
    now += TICKET_TTL_MS;
    expect(ts.consume(t2, A, SHA1)).toEqual({ ok: false, reason: 'expired' });

    now = NOW;
    const t3 = ts.issue(A, SHA1).ticket;
    expect(ts.consume(t3, B, SHA1)).toEqual({ ok: false, reason: 'wrong-app' });
    const t4 = ts.issue(A, SHA1).ticket;
    expect(ts.consume(t4, A, SHA2)).toEqual({ ok: false, reason: 'version-changed' });
    expect(ts.consume(t4, A, SHA1)).toEqual({ ok: false, reason: 'unknown' }); // a refusal still spends it
    expect(ts.consume(undefined, A, SHA1)).toEqual({ ok: false, reason: 'missing' });
    expect(ts.consume(['x'], A, SHA1)).toEqual({ ok: false, reason: 'missing' });
  });
  it('stays bounded', () => {
    const ts = new TicketStore(() => NOW);
    for (let i = 0; i < 2100; i++) ts.issue(A, SHA1);
    expect(ts.size()).toBeLessThanOrEqual(2000);
  });
});

describe('origin allow-list', () => {
  const deps = { knownHttpsHosts: () => ['echo.dawn-tunnel.dev', null, 'Abc-Quick.trycloudflare.com'], acceptsOwnName: (h: string) => h === 'studio.tail1234.ts.net' };
  const req = (host: string | undefined, localPort = 4042, secure = false) => ({ headers: { host }, secure, socket: { localPort } }) as never;
  it('accepts localhost names only on the port the request arrived on', () => {
    expect(resolveKnownOrigin(req('localhost:4042'), deps)).toBe('http://localhost:4042');
    expect(resolveKnownOrigin(req('127.0.0.1:4042'), deps)).toBe('http://127.0.0.1:4042');
    expect(resolveKnownOrigin(req('[::1]:4042'), deps)).toBe('http://[::1]:4042');
    expect(resolveKnownOrigin(req('localhost:9999'), deps)).toBeNull();
    expect(resolveKnownOrigin(req('localhost'), deps)).toBeNull();
  });
  it('accepts the tunnel, the named host and own names over https', () => {
    expect(resolveKnownOrigin(req('echo.dawn-tunnel.dev'), deps)).toBe('https://echo.dawn-tunnel.dev');
    expect(resolveKnownOrigin(req('ECHO.dawn-tunnel.dev:443'), deps)).toBe('https://echo.dawn-tunnel.dev');
    expect(resolveKnownOrigin(req('abc-quick.trycloudflare.com'), deps)).toBe('https://abc-quick.trycloudflare.com');
    expect(resolveKnownOrigin(req('studio.tail1234.ts.net'), deps)).toBe('https://studio.tail1234.ts.net');
  });
  it('refuses anything else', () => {
    for (const h of [undefined, '', 'evil.example', 'echo.dawn-tunnel.dev.evil.example', 'localhost.evil.example:4042', 'echo.dawn-tunnel.dev:8443', 'a b']) {
      expect(resolveKnownOrigin(req(h), deps)).toBeNull();
    }
  });
});

describe('frame headers — exact', () => {
  it('match the spec, word for word', () => {
    const o = 'https://echo.dawn-tunnel.dev';
    expect(frameCsp(o, A)).toBe(
      "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; "
      + `connect-src ${o}/project-apps/${A}/api/; form-action 'none'; base-uri 'none'; frame-ancestors ${o}`);
    expect(frameHeaders(o, A, SHA1)).toEqual({
      'Content-Security-Policy': frameCsp(o, A),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'ETag': `"${SHA1}"`,
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/html; charset=utf-8',
    });
    expect(frameCsp(o, A)).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-modals/);
    expect(wrapperCsp(o, A)).toContain(`frame-src ${o}/project-apps/${A}/frame;`);
  });
});

// ── exact exemptions ──

function mockRes() {
  const res = { statusCode: 0, body: undefined as unknown, headers: {} as Record<string, string> } as unknown as Response & { statusCode: number; body: unknown; headers: Record<string, string> };
  res.status = ((n: number) => { res.statusCode = n; return res; }) as Response['status'];
  res.json = ((b: unknown) => { res.body = b; return res; }) as Response['json'];
  res.send = ((b: unknown) => { res.body = b; return res; }) as Response['send'];
  res.type = (() => res) as unknown as Response['type'];
  res.set = ((k: string, v: string) => { res.headers[k.toLowerCase()] = v; return res; }) as unknown as Response['set'];
  res.header = ((k: string, v: string) => { res.headers[k.toLowerCase()] = v; return res; }) as unknown as Response['header'];
  res.sendStatus = ((n: number) => { res.statusCode = n; return res; }) as Response['sendStatus'];
  return res;
}
function runAuth(method: string, path: string, auth?: string) {
  const headers: Record<string, unknown> = { 'cf-connecting-ip': '203.0.113.7' };
  if (auth) headers.authorization = auth;
  const req = { path, method, headers, query: {}, socket: { remoteAddress: '::ffff:172.16.0.9' } } as unknown as Request;
  const res = mockRes();
  let nexted = false;
  authMiddleware(() => 'agent-token-for-tests', 'test-agent')(req, res, (() => { nexted = true; }) as NextFunction);
  return { nexted, status: res.statusCode };
}

describe('auth exemption — exact method + path, never a prefix', () => {
  const PUBLIC: Array<[string, string]> = [
    ['GET', `/project-apps/${A}/frame`], ['GET', `/project-apps/${A}/api/data`], ['PUT', `/project-apps/${A}/api/data`],
    ['GET', `/project-apps/${A}/api/summary`], ['PUT', `/project-apps/${A}/api/summary`],
    // Express matches routes case-insensitively, so the exemption does too (the handler re-checks the id).
    ['GET', `/Project-Apps/${A}/FRAME`], ['put', `/project-apps/${A}/API/data`],
  ];
  for (const [m, p] of PUBLIC) it(`${m} ${p} passes without a Bearer`, () => { expect(runAuth(m, p).nexted).toBe(true); });

  const GATED: Array<[string, string]> = [
    ['POST', `/project-apps/${A}/ticket`], ['POST', `/project-apps/${A}/key`], ['POST', '/project-apps'],
    ['POST', `/project-apps/${A}/frame`], ['DELETE', `/project-apps/${A}/api/data`], ['POST', `/project-apps/${A}/api/data`],
    ['GET', `/project-apps/${A}/frame/`], ['GET', `/project-apps/${A}/frame/x`], ['GET', `/project-apps/${A}/api/data/x`],
    ['GET', `/project-apps/${A}/api/other`], ['GET', `/project-apps/${A}/api/`], ['GET', '/project-apps/pa_0123/frame'],
    ['GET', `/project-apps/${A}x/frame`], ['GET', `/x/project-apps/${A}/frame`], ['GET', `/project-apps/${A}/../../work-board`],
  ];
  for (const [m, p] of GATED) it(`${m} ${p} needs the Bearer (401 without)`, () => {
    expect(runAuth(m, p)).toEqual({ nexted: false, status: 401 });
  });

  it('isProjectAppPublicRoute agrees with the middleware', () => {
    for (const [m, p] of PUBLIC) expect(isProjectAppPublicRoute(m, p)).toBe(true);
    for (const [m, p] of GATED) expect(isProjectAppPublicRoute(m, p)).toBe(false);
  });

  it('a narrow key sent as a Bearer is a plain 401, never a token comparison', () => {
    const key = mintKey(SECRET, { appId: A, contentSha: SHA1, exp: NOW + 1, epoch: 1 });
    expect(runAuth('POST', '/messages/send', `Bearer ${key}`)).toEqual({ nexted: false, status: 401 });
    expect(runAuth('POST', '/messages/send', 'Bearer agent-token-for-tests').nexted).toBe(true);
  });

  it('the middleware source lists the exemption by its exact helper (lint)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/server/middleware.ts'), 'utf8');
    expect(src).toContain('isProjectAppPublicRoute(req.method, req.path)');
    expect(src).not.toMatch(/startsWith\(['"]\/project-apps/);
    const sb = fs.readFileSync(path.resolve(__dirname, '../../src/server/ProjectAppSandbox.ts'), 'utf8');
    expect(sb).toContain('export const PROJECT_APP_FRAME_PATH = /^\\/project-apps\\/pa_[0-9a-f]{16}\\/frame$/i;');
    expect(sb).toContain('export const PROJECT_APP_API_PATH = /^\\/project-apps\\/pa_[0-9a-f]{16}\\/api\\/(data|summary)$/i;');
  });
});

describe('CORS — a branch for exactly the api paths', () => {
  const run = (method: string, path: string, origin?: string) => {
    const req = { path, method, headers: origin === undefined ? {} : { origin } } as unknown as Request;
    const res = mockRes();
    let nexted = false;
    corsMiddleware(req, res, (() => { nexted = true; }) as NextFunction);
    return { res, nexted };
  };
  it('a preflight on an api path allows Origin null, GET/PUT, the key header, no credentials', () => {
    const { res, nexted } = run('OPTIONS', `/project-apps/${A}/api/data`, 'null');
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('null');
    expect(res.headers['access-control-allow-methods']).toBe('GET, PUT, OPTIONS');
    expect(res.headers['access-control-allow-headers']).toBe('X-Project-App-Key, Content-Type');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
  it('a real origin on an api path is not echoed', () => {
    const { res } = run('GET', `/project-apps/${A}/api/summary`, 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('every other path keeps the generic policy: no null origin, no key header', () => {
    for (const p of [`/project-apps/${A}/frame`, `/project-apps/${A}/key`, '/work-board/cards/x/tap', `/project-apps/${A}/api/data/x`]) {
      const { res } = run('OPTIONS', p, 'null');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-headers']).toBe('Content-Type, Authorization');
    }
  });
});

describe('dashboardSecurityHeaders — the wrapper branch', () => {
  const run = (path: string, query: Record<string, string>, resolver?: (r: Request) => string | null) => {
    const req = { path, query, get: () => 'localhost:4042', app: { locals: resolver ? { projectAppOrigin: resolver } : {} } } as unknown as Request;
    const res = mockRes();
    let nexted = false;
    dashboardSecurityHeaders(req, res, (() => { nexted = true; }) as NextFunction);
    return { res, nexted };
  };
  it('sets the wrapper policy with frame-src for this app on the known origin', () => {
    const { res, nexted } = run('/dashboard/project-app/', { app: A }, () => 'http://localhost:4042');
    expect(nexted).toBe(true);
    expect(res.headers['content-security-policy']).toBe(wrapperCsp('http://localhost:4042', A));
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
  it('refuses (400) an unknown origin, a missing resolver or a bad app id', () => {
    expect(run('/dashboard/project-app/', { app: A }, () => null).res.statusCode).toBe(400);
    expect(run('/dashboard/project-app/index.html', { app: A }).res.statusCode).toBe(400);
    expect(run('/dashboard/project-app/', { app: 'pa_x' }, () => 'http://localhost:4042').res.statusCode).toBe(400);
  });
  it('leaves the wrapper script and other dashboard pages on the ordinary policy', () => {
    const js = run('/dashboard/project-app/wrapper.js', {}, () => 'http://localhost:4042');
    expect(js.nexted).toBe(true);
    expect(js.res.headers['content-security-policy']).not.toContain('frame-src');
  });
});

describe('wrapper rules (dashboard/project-app/wrapper-model.js)', () => {
  it('backs off 30 s, 1, 2, 4, 8 min, then every 15 min', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 40].map(backoffDelay)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, BACKOFF_FLOOR_MS, BACKOFF_FLOOR_MS, BACKOFF_FLOOR_MS]);
  });
  it('renews two minutes before expiry, never in the past', () => {
    expect(renewDelay(NOW + KEY_TTL_MS, NOW)).toBe(13 * 60_000);
    expect(renewDelay(NOW + 60_000, NOW)).toBe(0);
  });
  it('accepts only ready, summary-changed and open-conversation, only from the frame', () => {
    const frameWin = {};
    expect(acceptMessage({ source: frameWin, data: { type: 'ready' } }, frameWin)).toBe('ready');
    expect(acceptMessage({ source: frameWin, data: { type: 'open-conversation', target: 'https://evil.example' } }, frameWin)).toBe('open-conversation');
    expect(acceptMessage({ source: {}, data: { type: 'ready' } }, frameWin)).toBeNull();
    for (const data of [{ type: 'renew' }, { type: 'get-key' }, 'ready', null, { type: 1 }]) expect(acceptMessage({ source: frameWin, data }, frameWin)).toBeNull();
  });
  it('reloads on a changed version, stops when nothing is served, otherwise retries', () => {
    expect(classifyKeyAnswer(200, { key: 'pak_x' })).toBe('ok');
    expect(classifyKeyAnswer(409, { error: 'version-changed' })).toBe('reload');
    expect(classifyKeyAnswer(409, { error: 'not-served' })).toBe('stopped');
    expect(classifyKeyAnswer(0, null)).toBe('retry');
    expect(classifyKeyAnswer(503, { error: 'key-secret-unavailable' })).toBe('retry');
  });
  it('keeps the conversation link on this dashboard', () => {
    expect(safeConversationHref('/dashboard/console/#/x')).toBe('/dashboard/console/#/x');
    for (const h of ['https://evil.example', '//evil.example/dashboard/', 'javascript:alert(1)', '/work-board', null]) expect(safeConversationHref(h)).toBeNull();
  });
});

describe('the key is redacted next to bearer tokens', () => {
  const key = mintKey(SECRET, { appId: A, contentSha: SHA1, exp: NOW + 1, epoch: 1 });
  it('Redactor blanks the bare key and the header line', () => {
    const r = new Redactor().redact(`sent ${key} and X-Project-App-Key: ${key}`);
    expect(r.text).not.toContain(key.slice(4, 30));
  });
  it('the credential shapes recognise it', () => {
    expect(CREDENTIAL_SHAPES.some((s) => s.name === 'Project app key' && s.pattern.test(key))).toBe(true);
  });
});

describe('switch', () => {
  it('projectApps.custom.enabled follows the development-agent gate', () => {
    expect(customProjectAppsEnabled({ developmentAgent: true })).toBe(true);
    expect(customProjectAppsEnabled({})).toBe(false);
    expect(customProjectAppsEnabled({ developmentAgent: true, projectApps: { custom: { enabled: false } } })).toBe(false);
  });
});

describe('the app api token bucket', () => {
  it('allows the burst, refuses past it, refills at the rate, and keeps apps apart', () => {
    let t = 1_000_000;
    const b = new TokenBuckets(API_RATE_DEFAULT, () => t);
    let ok = 0;
    for (let i = 0; i < 100; i++) if (b.take('pa_a')) ok++;
    expect(ok).toBe(API_RATE_DEFAULT.burst);
    expect(b.take('pa_b')).toBe(true);
    t += 500; // half a second: 10 more at 20/s
    ok = 0;
    for (let i = 0; i < 100; i++) if (b.take('pa_a')) ok++;
    expect(ok).toBe(10);
    t += 60_000; // never above the burst
    ok = 0;
    for (let i = 0; i < 100; i++) if (b.take('pa_a')) ok++;
    expect(ok).toBe(API_RATE_DEFAULT.burst);
  });
});
