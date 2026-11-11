/**
 * Linking a member's computer from their own phone (instar-document-viewer §3.6a): the page's
 * nonce, the phone's link, the allowance, guests read only, forget, and the expiry sweep.
 */
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DeviceRegistry } from '../../src/core/MobileDeviceKeys.js';
import { deviceKeyHashOf } from '../../src/core/AppRecordSignatures.js';
import { callerAddress, createDocumentLinkRoutes, describeBrowser, forgetLinkedBrowser, LINK_MAX_CODES_PER_CALLER, linkFingerprint, sweepLinkedBrowsers } from '../../src/server/documentLinkRoutes.js';
import { DOC_PAGE_PATH } from '../../src/server/middleware.js';

const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/documents-link.test.ts' }); });

const HOST = 'echo.example.dev';
function rawKey(): string {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
}

function setup(tier: 'member' | 'guest' = 'member') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclink-')); tmp.push(dir);
  const clock = { t: Date.parse('2026-11-10T20:00:00Z') };
  const devices = new DeviceRegistry(dir, () => clock.t);
  const phoneKey = rawKey();
  const pending = devices.createPending({ deviceName: 'Mara’s iPhone', label: null, publicKey: phoneKey, host: HOST, userId: 'mara', role: 'team' });
  if (!pending.ok) throw new Error('setup');
  devices.applyConfirm(pending.device.id, { ok: true });
  const phone = pending.device;
  const events: Array<Record<string, unknown>> = [];
  const state = { bindings: new Map<string, string>([[deviceKeyHashOf(phoneKey), 'mara']]), browserLinks: new Map<string, Record<string, unknown>>() };
  const revoked = new Set<string>();
  const activations: string[] = [];
  const log = { health: 'ok' as 'ok' | 'unreadable', removed: new Set<string>(), failAppend: false };
  const faults: string[] = [];
  const svc = {
    devices,
    browserOn: () => true,
    keyLedger: {
      recordActivation: (d: { id: string }) => { activations.push(d.id); return {}; },
      recordRevocation: (d: { browserPublicKey?: string }) => { if (d.browserPublicKey) revoked.add(deviceKeyHashOf(d.browserPublicKey)); return {}; },
      isRevoked: (kh: string) => revoked.has(kh),
      keyRevoked: (kh: string) => revoked.has(kh),
    },
    teamLog: () => ({
      healthState: () => log.health,
      wasRemoved: (k: string) => log.removed.has(k),
      state: () => state,
      appendMachineEvents: (evs: Array<Record<string, unknown>>) => {
        if (log.failAppend) throw new Error('disk full');
        for (const e of evs) {
          events.push(e);
          if (e.type === 'browser-bind') { state.bindings.set(e.keyHash as string, e.boundTo as string); state.browserLinks.set(e.keyHash as string, e); }
          if (e.type === 'browser-unbind') { state.bindings.delete(e.keyHash as string); const l = state.browserLinks.get(e.keyHash as string); if (l) state.browserLinks.set(e.keyHash as string, { ...l, unbound: true }); }
        }
      },
    }),
    personOfDevice: (d: { userId?: string; role?: string }) => (d.role === 'team' ? { ok: true, role: 'team', userId: d.userId, name: 'Mara', tier } : { ok: true, role: 'owner', userId: null, name: 'J' }),
    teamStanding: (k: string) => (k === 'mara' && !log.removed.has(k) ? { name: 'Mara', tier } : null),
    reportTeamFault: (feature: string) => { faults.push(feature); },
  };
  const a = express();
  a.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = Buffer.from(buf); } }));
  a.use((req, _res, next) => {
    if (req.path.startsWith('/mobile/') && req.headers['x-test-device']) (req as unknown as Record<string, unknown>).instarPrincipal = { kind: 'device', deviceId: req.headers['x-test-device'] };
    next();
  });
  a.use(createDocumentLinkRoutes({ config: () => ({ developmentAgent: true }), pairing: () => svc as never, machineId: () => 'm_studio', isOwnHost: (h) => h === HOST, now: () => clock.t }));
  return { a, phone, phoneKey, svc, events, clock, devices, revoked, activations, log, faults };
}

async function link(s: ReturnType<typeof setup>, key = rawKey(), over: Record<string, unknown> = {}) {
  const n = await request(s.a).post('/docs/_link/nonce').set('Host', HOST).set('X-Instar-Request', '1').send({ browserPublicKey: key });
  expect(n.status).toBe(200);
  const body = { browserPublicKey: key, nonce: n.body.nonce, machineId: n.body.machineId, host: HOST, expiresAt: new Date(s.clock.t + 30 * 86_400_000).toISOString(), ...over };
  const r = await request(s.a).post('/mobile/browsers/link').set('x-test-device', s.phone.id).set('x-instar-device-time', String(s.clock.t)).set('x-instar-device-sig', 'MEUCIQ').set('Content-Type', 'application/json').send(JSON.stringify(body));
  return { r, nonce: n.body.nonce as string, key };
}

describe('linking a member computer', () => {
  it('the page gets a nonce for its key; the phone links it; the page sees it linked', async () => {
    const s = setup();
    const { r, nonce, key } = await link(s);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ host: HOST, scope: 'documents' });
    const d = s.devices.get(r.body.id)!;
    expect(d).toMatchObject({ client: 'browser', role: 'team', userId: 'mara', scope: 'documents', approvedVia: 'person-phone', linkedByDeviceId: s.phone.id });
    expect(s.activations).toEqual([d.id]);
    const bind = s.events.find((e) => e.type === 'browser-bind')!;
    expect(bind).toMatchObject({ keyHash: deviceKeyHashOf(key), boundTo: 'mara', scope: 'documents' });
    expect(JSON.parse(Buffer.from((bind.signed as { bodyB64: string }).bodyB64, 'base64url').toString()).browserPublicKey).toBe(key);
    expect((await request(s.a).post('/docs/_link/status').set('X-Instar-Request', '1').send({ nonce })).body).toEqual({ state: 'linked', deviceId: d.id });
    // The binding names the exact phone key that signed it.
    expect(bind.linkedByKeyHash).toBe(deviceKeyHashOf(s.phoneKey));
    expect(d.linkedByKeyHash).toBe(deviceKeyHashOf(s.phoneKey));
    const list = await request(s.a).get('/mobile/browsers').set('x-test-device', s.phone.id);
    expect(list.body.browsers).toEqual([expect.objectContaining({ id: d.id, fingerprint: linkFingerprint(key) })]);
  });

  it('a nonce is single-use and only for the key it was issued to', async () => {
    const s = setup();
    const first = await link(s);
    expect(first.r.status).toBe(201);
    const again = await request(s.a).post('/mobile/browsers/link').set('x-test-device', s.phone.id).set('x-instar-device-time', '1').set('x-instar-device-sig', 'x').set('Content-Type', 'application/json')
      .send(JSON.stringify({ browserPublicKey: first.key, nonce: first.nonce, machineId: 'm_studio', host: HOST, expiresAt: new Date(s.clock.t + 86_400_000).toISOString() }));
    expect(again.status).toBe(410);
    const other = await link(s, rawKey(), { browserPublicKey: rawKey() });
    expect(other.r.status).toBe(410);
  });

  it('refuses a far expiry, another machine, and more than three computers', async () => {
    const s = setup();
    expect((await link(s, rawKey(), { expiresAt: new Date(s.clock.t + 40 * 86_400_000).toISOString() })).r.status).toBe(400);
    expect((await link(s, rawKey(), { machineId: 'm_other' })).r.status).toBe(409);
    for (let i = 0; i < 3; i++) expect((await link(s)).r.status).toBe(201);
    const fourth = await link(s);
    expect(fourth.r.status).toBe(409);
    expect(fourth.r.body.error).toBe('browser-link-limit');
  });

  it('a guest computer is read-only; forget removes it everywhere', async () => {
    const s = setup('guest');
    const { r, key } = await link(s);
    expect(r.body.scope).toBe('documents-read');
    const f = await request(s.a).post(`/mobile/browsers/${r.body.id}/forget`).set('x-test-device', s.phone.id).set('Content-Type', 'application/json').send('{}');
    expect(f.status).toBe(200);
    expect(s.devices.get(r.body.id)!.status).toBe('revoked');
    expect(s.revoked.has(deviceKeyHashOf(key))).toBe(true);
    expect(s.events.some((e) => e.type === 'browser-unbind')).toBe(true);
  });

  it('the sweep never removes anything while the team log is unreadable, and removes a person the log says left', async () => {
    const s = setup();
    const a1 = await link(s);
    s.log.health = 'unreadable';
    s.log.removed.add('mara');
    expect(sweepLinkedBrowsers(s.svc as never, s.clock.t)).toBe(0);
    expect(s.devices.get(a1.r.body.id)!.status).toBe('active');
    s.log.health = 'ok';
    expect(sweepLinkedBrowsers(s.svc as never, s.clock.t)).toBe(1);
    expect(s.devices.get(a1.r.body.id)!.status).toBe('revoked');
  });

  it('forgetting does not reset the hourly allowance, and a key is never linked twice', async () => {
    const s = setup();
    for (let i = 0; i < 4; i++) {
      const l = await link(s);
      expect(l.r.status).toBe(201);
      await request(s.a).post(`/mobile/browsers/${l.r.body.id}/forget`).set('x-test-device', s.phone.id).set('Content-Type', 'application/json').send('{}');
    }
    expect((await link(s)).r.status).toBe(429);
    s.clock.t += 2 * 3_600_000;
    const key = rawKey();
    expect((await link(s, key)).r.status).toBe(201);
    expect((await link(s, key)).r.status).toBe(409);
  });

  it('the sweep removes expired links and links whose phone was revoked', async () => {
    const s = setup();
    const a1 = await link(s, rawKey(), { expiresAt: new Date(s.clock.t + 86_400_000).toISOString() });
    const a2 = await link(s);
    s.clock.t += 2 * 86_400_000;
    expect(sweepLinkedBrowsers(s.svc as never, s.clock.t)).toBe(1);
    expect(s.devices.get(a1.r.body.id)!.status).toBe('revoked');
    s.devices.revoke(s.phone.id);
    expect(sweepLinkedBrowsers(s.svc as never, s.clock.t)).toBe(1);
    expect(s.devices.get(a2.r.body.id)!.status).toBe('revoked');
  });

  it('the phone sees who asked for the code (browser, address, age) before Face ID, and with the link', async () => {
    const s = setup();
    const key = rawKey();
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    // Through the tunnel: loopback peer (cloudflared), this agent's own name, the visitor's address in cf-connecting-ip.
    const n = await request(s.a).post('/docs/_link/nonce').set('Host', HOST).set('X-Instar-Request', '1').set('User-Agent', UA).set('cf-connecting-ip', '203.0.113.7').send({ browserPublicKey: key });
    expect(n.status).toBe(200);
    s.clock.t += 120_000;
    const look = await request(s.a).post('/mobile/browsers/link/lookup').set('x-test-device', s.phone.id).send({ nonce: n.body.nonce, browserPublicKey: key });
    expect(look.status).toBe(200);
    expect(look.body).toEqual({
      state: 'waiting', fingerprint: linkFingerprint(key), host: HOST, expiresAt: n.body.expiresAt,
      requester: { address: '203.0.113.7', browser: 'Chrome on macOS', at: new Date(s.clock.t - 120_000).toISOString(), agoSeconds: 120 },
    });
    // The wrong key or an unknown code reads as expired; an owner phone is told to use the console flow.
    expect((await request(s.a).post('/mobile/browsers/link/lookup').set('x-test-device', s.phone.id).send({ nonce: n.body.nonce, browserPublicKey: rawKey() })).status).toBe(410);
    const body = { browserPublicKey: key, nonce: n.body.nonce, machineId: 'm_studio', host: HOST, expiresAt: new Date(s.clock.t + 86_400_000).toISOString() };
    const r = await request(s.a).post('/mobile/browsers/link').set('x-test-device', s.phone.id).set('x-instar-device-time', String(s.clock.t)).set('x-instar-device-sig', 'MEUCIQ').set('Content-Type', 'application/json').send(JSON.stringify(body));
    expect(r.status).toBe(201);
    expect(r.body.requester).toMatchObject({ address: '203.0.113.7', browser: 'Chrome on macOS', agoSeconds: 120 });
  });

  it('describes browsers from a fixed vocabulary, never echoing the header', () => {
    expect(describeBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15')).toBe('Safari on macOS');
    expect(describeBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0')).toBe('Edge on Windows');
    expect(describeBrowser('Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0')).toBe('Firefox on Linux');
    expect(describeBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1')).toBe('Chrome on iPhone');
    expect(describeBrowser('<script>alert(1)</script>')).toBe('an unknown browser');
    expect(describeBrowser(undefined)).toBe('an unknown browser');
  });

  it('trusts cf-connecting-ip only for a request that came through the tunnel', () => {
    const req = (remote: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: remote }, headers }) as never;
    expect(callerAddress(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' }), true)).toBe('203.0.113.7');
    // Sent straight to the port from elsewhere, or on a Host that is not the agent's own: the socket's address.
    expect(callerAddress(req('::ffff:198.51.100.4', { 'cf-connecting-ip': '203.0.113.7' }), true)).toBe('198.51.100.4');
    expect(callerAddress(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' }), false)).toBe('127.0.0.1');
    expect(callerAddress(req('127.0.0.1', { 'cf-connecting-ip': 'not-an-ip' }), true)).toBe('127.0.0.1');
  });

  it('caps outstanding codes per caller address, so one caller cannot lock out everyone', async () => {
    const s = setup();
    const ask = (ip: string, key = rawKey()) => request(s.a).post('/docs/_link/nonce').set('Host', HOST).set('X-Instar-Request', '1').set('cf-connecting-ip', ip).send({ browserPublicKey: key });
    for (let i = 0; i < LINK_MAX_CODES_PER_CALLER; i++) expect((await ask('203.0.113.7')).status).toBe(200);
    const fourth = await ask('203.0.113.7');
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toBe('too-many-codes');
    // Another caller is unaffected.
    expect((await ask('198.51.100.4')).status).toBe(200);
    // The same key asking again replaces its own earlier code (a reloaded page never locks itself out).
    const key = rawKey();
    const first = await ask('192.0.2.1', key);
    for (let i = 0; i < 5; i++) expect((await ask('192.0.2.1', key)).status).toBe(200);
    expect((await request(s.a).post('/docs/_link/status').set('X-Instar-Request', '1').send({ nonce: first.body.nonce })).body.state).toBe('expired');
    // A forged cf-connecting-ip sent straight to the port (not through the tunnel) is the socket's address.
    s.clock.t += 11 * 60_000;
    expect(callerAddress({ socket: { remoteAddress: '198.51.100.9' }, headers: { 'cf-connecting-ip': '1.1.1.1' } } as never, false)).toBe('198.51.100.9');
  });

  it('when the binding cannot be written, the link is undone and reported, never a 500', async () => {
    const s = setup();
    s.log.failAppend = true;
    const { r, key } = await link(s);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('link-not-recorded');
    // The undo's own unbind also failed: reported, and the computer is still revoked here and in the ledger.
    expect(s.faults).toEqual(['Documents.linkRecord', 'Documents.linkUndo']);
    expect(s.revoked.has(deviceKeyHashOf(key))).toBe(true);
    expect(s.devices.list().find((d) => d.browserPublicKey === key)!.status).toBe('revoked');
  });

  it('forgetting runs every step even when one throws, then reports the first failure', () => {
    const s = setup();
    s.log.failAppend = true;
    const created = s.devices.createLinkedBrowser({ browserPublicKey: rawKey(), host: HOST, userId: 'mara', scope: 'documents', linkedByDeviceId: s.phone.id, linkedByKeyHash: deviceKeyHashOf(s.phoneKey), linkExpiresAt: new Date(s.clock.t + 86_400_000).toISOString(), approvedAt: new Date(s.clock.t).toISOString() });
    if (!created.ok) throw new Error('setup');
    expect(() => forgetLinkedBrowser(s.svc as never, created.device, new Date(s.clock.t).toISOString())).toThrow('disk full');
    expect(s.devices.get(created.device.id)!.status).toBe('revoked');
  });

  it('the page routes are open without a credential, exactly those two', () => {
    expect(DOC_PAGE_PATH('POST', '/docs/_link/nonce')).toBe(true);
    expect(DOC_PAGE_PATH('POST', '/docs/_link/status')).toBe(true);
    // The nonce never travels in a URL: the old GET form is not a page route.
    expect(DOC_PAGE_PATH('GET', '/docs/_link/status')).toBe(false);
    expect(DOC_PAGE_PATH('GET', '/docs/_link/nonce')).toBe(false);
  });
});

describe('a linked computer seen from another machine', () => {
  const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const lowS = (der: Buffer): Buffer => {
    const rLen = der[3]; const r = der.subarray(4, 4 + rLen); const sLen = der[5 + rLen]; let v = BigInt('0x' + der.subarray(6 + rLen, 6 + rLen + sLen).toString('hex'));
    if (v > N / 2n) v = N - v;
    let h = v.toString(16); if (h.length % 2) h = '0' + h; let sb = Buffer.from(h, 'hex'); if (sb[0] & 0x80) sb = Buffer.concat([Buffer.from([0]), sb]);
    const body = Buffer.concat([Buffer.from([2, r.length]), r, Buffer.from([2, sb.length]), sb]);
    return Buffer.concat([Buffer.from([0x30, body.length]), body]);
  };
  const phone = () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
    return { raw, privateKey, keyHash: deviceKeyHashOf(raw) };
  };
  it('is trusted only with the linking phone\'s real signature over exactly this key and expiry', async () => {
    const { verifyBrowserLink } = await import('../../src/server/documentLinkRoutes.js');
    const { canonicalString } = await import('../../src/core/MobileDeviceKeys.js');
    const p = phone(); const other = phone();
    const browserKey = rawKey();
    const now = Date.parse('2026-11-10T20:00:00Z');
    const expiresAt = new Date(now + 86_400_000).toISOString();
    const body = Buffer.from(JSON.stringify({ browserPublicKey: browserKey, nonce: 'n', machineId: 'm', host: HOST, expiresAt }));
    const sign = (k: ReturnType<typeof phone>) => lowS(crypto.sign('sha256', Buffer.from(canonicalString('mara-phone', HOST, 'POST', '/mobile/browsers/link', String(now), body)), { key: k.privateKey, dsaEncoding: 'der' })).toString('base64url');
    const link = (sig: string, over: Record<string, unknown> = {}) => ({ type: 'browser-bind' as const, keyHash: deviceKeyHashOf(browserKey), deviceId: 'b1', boundTo: 'mara', linkedByDeviceId: 'mara-phone', linkedByKeyHash: p.keyHash, linkedAt: new Date(now).toISOString(), expiresAt, scope: 'documents' as const, signed: { host: HOST, timeMs: String(now), sig, bodyB64: body.toString('base64url') }, ...over });
    const ph = { keyHash: p.keyHash, publicKey: p.raw };
    expect(verifyBrowserLink(link(sign(p)), ph, 'mara', false, now)).toBe(true);
    // A machine can't make one up: another key's signature, another person, a revoked phone, a different key or expiry, or after expiry.
    expect(verifyBrowserLink(link(sign(other)), ph, 'mara', false, now)).toBe(false);
    expect(verifyBrowserLink(link(sign(p)), ph, 'sam', false, now)).toBe(false);
    expect(verifyBrowserLink(link(sign(p)), ph, 'mara', true, now)).toBe(false);
    expect(verifyBrowserLink(link(sign(p), { keyHash: deviceKeyHashOf(rawKey()) }), ph, 'mara', false, now)).toBe(false);
    expect(verifyBrowserLink(link(sign(p), { expiresAt: new Date(now + 2 * 86_400_000).toISOString() }), ph, 'mara', false, now)).toBe(false);
    expect(verifyBrowserLink(link(sign(p)), ph, 'mara', false, now + 2 * 86_400_000)).toBe(false);
    // Only the key the binding names: the phone's other (newer) key never stands in for the signer,
    // even when that other key made the signature.
    const otherKey = { keyHash: other.keyHash, publicKey: other.raw };
    expect(verifyBrowserLink(link(sign(other)), otherKey, 'mara', false, now)).toBe(false);
    expect(verifyBrowserLink(link(sign(p), { linkedByKeyHash: other.keyHash }), ph, 'mara', false, now)).toBe(false);
  });

  it('a scoped computer may send only the exact Send template, into a chat route', async () => {
    const { scopedSendTarget } = await import('../../src/server/documentLinkRoutes.js');
    const id = '12345678-1234-4234-8234-123456789abc';
    expect(scopedSendTarget(`I left 3 comments on "Plan" (version 4): https://${HOST}/docs/${id}`, '/mobile/chat/77')).toEqual({ docId: id, conversation: 'telegram:77' });
    expect(scopedSendTarget(`I left 1 comment on "Plan" (version 1): https://${HOST}/docs/${id}`, `/mobile/chat/app/${id}`)).toEqual({ docId: id, conversation: `app:${id}` });
    expect(scopedSendTarget(`I left 3 comments on "Plan" (version 4): https://${HOST}/docs/${id} and also do X`, '/mobile/chat/77')).toBeNull();
    expect(scopedSendTarget('Approve the deploy', '/mobile/chat/77')).toBeNull();
    expect(scopedSendTarget(`I left 3 comments on "Plan" (version 4): https://${HOST}/docs/${id}`, '/mobile/conversations')).toBeNull();
  });
});

describe('the agent\'s own machine as a host', () => {
  it('counts only this server\'s own loopback port, from a loopback peer, with no forwarding header', async () => {
    const { ownLoopbackHost } = await import('../../src/server/documentLinkRoutes.js');
    const req = (remote: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: remote }, headers }) as never;
    expect(ownLoopbackHost(req('127.0.0.1'), 'localhost:4062', 4062)).toBe(true);
    expect(ownLoopbackHost(req('::1'), '127.0.0.1:4062', 4062)).toBe(true);
    expect(ownLoopbackHost(req('127.0.0.1'), 'localhost:9999', 4062)).toBe(false);
    expect(ownLoopbackHost(req('192.168.1.5'), 'localhost:4062', 4062)).toBe(false);
    expect(ownLoopbackHost(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }), 'localhost:4062', 4062)).toBe(false);
    expect(ownLoopbackHost(req('127.0.0.1'), 'echo.example.dev', 4062)).toBe(false);
  });
});
