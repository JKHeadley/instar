/**
 * HTTP pipeline for Remote Desktop with Face ID and the PIN page (docs/specs/mobile-owner-presence-pin.md)
 * through the production authMiddleware + deviceAuthenticator + the real MobilePairingService.
 *
 * An owner phone with an enrolled presence key unlocks Remote Desktop and gets a desktop-only, phone-bound
 * session; the desktop routes accept it only on that phone's signed requests; a bearer caller, another
 * phone, an MSP phone, a revoked phone, the switch off, a PIN change, a reused or cross-purpose challenge,
 * a wrong-purpose signature, no PIN and a placeholder PIN are each refused and audited. The reveal returns
 * exactly the PIN, tells the owner without it, and is refused where there is no private chat.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { mountOwnerPresenceRoutes, mountPhoneSessionBinding, ownerPresenceMessage, isOwnerPresenceEnabled, DESKTOP_UNLOCK_VERSION, PIN_REVEAL_VERSION } from '../../src/server/mobileOwnerPresenceRoutes.js';
import { PhoneDesktopSessionStore } from '../../src/server/PhoneDesktopSessionStore.js';
import { activeOwnerPhone, presenceMessage } from '../../src/server/mobileConsoleTicket.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { DASHBOARD_PIN_PLACEHOLDER } from '../../src/core/dashboardPin.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const PIN = '424242';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-owner-presence.test.ts' });
});

function setup(cfg: Record<string, unknown> = {}, opts: { ownerDM?: boolean; ownerPresent?: boolean; sendOk?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopres-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, dashboardPin: PIN, mobilePairing: { multiRoute: { enabled: false } }, ...cfg } as Record<string, unknown>;
  const dms: string[] = [];
  const svc = new MobilePairingService({
    config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self',
    // As production: ownerDM always exists; whether a Telegram owner is reachable is a separate live check,
    // and a send that doesn't go out resolves to null rather than throwing.
    ...(opts.ownerDM === false ? {} : { ownerDM: async (text: string) => { if (opts.sendOk === false) return null; dms.push(text); return 1; } }),
    telegramOwnerPresent: () => opts.ownerPresent !== false,
  } as unknown as MobilePairingDeps);
  services.push(svc);
  const sessions = new PhoneDesktopSessionStore();
  // The desktop routes' check, as AgentServer.verifyDesktopOperatorSession: dashboard session or a live phone session.
  const dashboard = new Set<string>(['dash-session']);
  const verifyDesktop = (t: string | undefined) => (!!t && dashboard.has(t))
    || (isOwnerPresenceEnabled(config as never) && sessions.verify(t, (id) => activeOwnerPhone(svc, id)) !== null);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use((req, _res, next) => { if (req.headers['x-test-lan']) Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.20', configurable: true }); next(); });
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  const router = express.Router();
  mountOwnerPresenceRoutes(router, { pairing: () => svc, config: () => config as never, phoneSessions: sessions, machineName: () => 'Mac Studio' });
  mountPhoneSessionBinding(router, sessions);
  // Stand-ins for two desktop routes and one non-desktop operator-session route, each with its real check.
  router.get('/desktop/targets', (req, res) => { res.status(verifyDesktop(req.get('X-Instar-Operator-Session')) ? 200 : 403).json({}); });
  router.get('/desktop/requests/:id/cursor', (req, res) => { res.status(verifyDesktop(req.get('X-Instar-Operator-Session')) ? 200 : 403).json({}); });
  router.post('/features/:id/transition', (req, res) => { res.status(dashboard.has(req.get('X-Instar-Operator-Session') ?? '') ? 200 : 403).json({}); });
  app.use(router);
  const pair = (person?: { userId: string; role: 'msp' }, withPresence = true) => {
    const dev = makeDevice();
    const presence = makeDevice();
    const created = svc.devices.createPending({ deviceName: 'Justin iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
    if (!created.ok) throw new Error('setup');
    svc.devices.applyConfirm(created.device.id, { ok: true });
    if (withPresence) svc.devices.setPresenceKey(created.device.id, presence.publicKey);
    return { dev, presence, id: created.device.id };
  };
  return { app, svc, pair, dir, config, dms, sessions };
}

type Phone = { dev: ReturnType<typeof makeDevice>; presence: ReturnType<typeof makeDevice>; id: string };
let tick = 0;
function send(app: express.Express, phone: Phone, method: 'GET' | 'POST', p: string, body?: unknown, extra: Record<string, string> = {}) {
  const time = String(Date.now() + (tick++ % 1000));
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const sig = phone.dev.sign(canonicalString(phone.id, HOST, method, p, time, raw));
  let r = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
  r = r.set('X-Instar-Device', phone.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  for (const [k, v] of Object.entries(extra)) r = r.set(k, v);
  return raw ? r.send(raw.toString()) : r;
}
async function challengeFor(app: express.Express, phone: Phone, p: string) {
  const r = await send(app, phone, 'POST', p, {});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.challenge as string;
}
async function unlock(app: express.Express, phone: Phone) {
  const c = await challengeFor(app, phone, '/mobile/desktop-unlock/challenge');
  return send(app, phone, 'POST', '/mobile/desktop-unlock', { challenge: c, presenceSig: phone.presence.sign(ownerPresenceMessage(DESKTOP_UNLOCK_VERSION, phone.id, HOST, c)) });
}
async function reveal(app: express.Express, phone: Phone) {
  const c = await challengeFor(app, phone, '/mobile/dashboard-pin/challenge');
  return send(app, phone, 'POST', '/mobile/dashboard-pin/reveal', { challenge: c, presenceSig: phone.presence.sign(ownerPresenceMessage(PIN_REVEAL_VERSION, phone.id, HOST, c)) });
}
const auditText = (dir: string) => fs.readFileSync(path.join(dir, 'state', 'mobile-owner-presence-audit.jsonl'), 'utf8');
const auditRows = (dir: string) => auditText(dir).trim().split('\n').map((l) => JSON.parse(l));

describe('Remote Desktop with Face ID', () => {
  it('an owner phone unlocks and its signed desktop calls carry the session; nothing else does', async () => {
    const c = setup();
    const p = c.pair();
    const r = await unlock(c.app, p);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(Object.keys(r.body).sort()).toEqual(['operatorSessionExpiresAt', 'operatorSessionToken']);
    const s = { 'X-Instar-Operator-Session': r.body.operatorSessionToken as string };
    expect((await send(c.app, p, 'GET', '/desktop/targets', undefined, s)).status).toBe(200);
    expect((await send(c.app, p, 'GET', '/desktop/requests/abc/cursor', undefined, s)).status).toBe(200);
    // Desktop-only: the same session is no operator session anywhere else.
    expect((await send(c.app, p, 'POST', '/features/x/transition', {}, s)).status).toBe(403);
  });

  it('the session is honoured only from the phone that minted it', async () => {
    const c = setup();
    const a = c.pair(), b = c.pair();
    const token = (await unlock(c.app, a)).body.operatorSessionToken as string;
    expect((await request(c.app).get('/desktop/targets').set('Authorization', 'Bearer tok-1').set('X-Instar-Operator-Session', token)).status).toBe(403);
    expect((await send(c.app, b, 'GET', '/desktop/targets', undefined, { 'X-Instar-Operator-Session': token })).status).toBe(403);
    // A dashboard session is untouched by the binding.
    expect((await request(c.app).get('/desktop/targets').set('Authorization', 'Bearer tok-1').set('X-Instar-Operator-Session', 'dash-session')).status).toBe(200);
  });

  it('revoking the phone, changing the PIN or turning the switch off ends the session', async () => {
    const c = setup();
    const p = c.pair();
    let token = (await unlock(c.app, p)).body.operatorSessionToken as string;
    c.sessions.clear(); // what AgentServer's PIN-change hook does
    expect((await send(c.app, p, 'GET', '/desktop/targets', undefined, { 'X-Instar-Operator-Session': token })).status).toBe(403);
    token = (await unlock(c.app, p)).body.operatorSessionToken as string;
    c.config.mobilePairing = { multiRoute: { enabled: false }, ownerPresence: { enabled: false } };
    expect((await send(c.app, p, 'GET', '/desktop/targets', undefined, { 'X-Instar-Operator-Session': token })).status).toBe(403);
    c.config.mobilePairing = { multiRoute: { enabled: false } };
    token = (await unlock(c.app, p)).body.operatorSessionToken as string;
    expect(c.svc.devices.revoke(p.id)).toBe(true);
    expect((await request(c.app).get('/desktop/targets').set('Authorization', 'Bearer tok-1').set('X-Instar-Operator-Session', token)).status).toBe(403);
    expect(c.sessions.verify(token, (id) => activeOwnerPhone(c.svc, id))).toBeNull();
  });

  it('refuses the wrong callers and proofs, each audited', async () => {
    const c = setup();
    const p = c.pair();
    // Bearer: no device principal.
    expect((await request(c.app).post('/mobile/desktop-unlock/challenge').set('Authorization', 'Bearer tok-1').send({})).body.error).toBe('device-signature-required');
    // MSP phone.
    expect((await send(c.app, c.pair({ userId: 'justin', role: 'msp' }), 'POST', '/mobile/desktop-unlock/challenge', {})).status).toBe(403);
    // Off the local front.
    expect((await send(c.app, p, 'POST', '/mobile/desktop-unlock/challenge', {}, { 'x-test-lan': '1' })).body.error).toBe('secure-transport-required');
    // No presence key.
    expect((await send(c.app, c.pair(undefined, false), 'POST', '/mobile/desktop-unlock/challenge', {})).body.error).toBe('presence-key-missing');
    // A reused challenge.
    const ch = await challengeFor(c.app, p, '/mobile/desktop-unlock/challenge');
    const body = { challenge: ch, presenceSig: p.presence.sign(ownerPresenceMessage(DESKTOP_UNLOCK_VERSION, p.id, HOST, ch)) };
    expect((await send(c.app, p, 'POST', '/mobile/desktop-unlock', body)).status).toBe(200);
    expect((await send(c.app, p, 'POST', '/mobile/desktop-unlock', body)).body.error).toBe('challenge-invalid');
    // A challenge from the other purpose's store.
    const pinCh = await challengeFor(c.app, p, '/mobile/dashboard-pin/challenge');
    expect((await send(c.app, p, 'POST', '/mobile/desktop-unlock', { challenge: pinCh, presenceSig: p.presence.sign(ownerPresenceMessage(DESKTOP_UNLOCK_VERSION, p.id, HOST, pinCh)) })).body.error).toBe('challenge-invalid');
    // A signature for another purpose (the PIN reveal, the console ticket) over a good challenge.
    for (const wrong of [(x: string) => ownerPresenceMessage(PIN_REVEAL_VERSION, p.id, HOST, x), (x: string) => presenceMessage(p.id, HOST, x)]) {
      const x = await challengeFor(c.app, p, '/mobile/desktop-unlock/challenge');
      expect((await send(c.app, p, 'POST', '/mobile/desktop-unlock', { challenge: x, presenceSig: p.presence.sign(wrong(x)) })).body.error).toBe('presence-invalid');
    }
    // The device key is not the presence key.
    const y = await challengeFor(c.app, p, '/mobile/desktop-unlock/challenge');
    expect((await send(c.app, p, 'POST', '/mobile/desktop-unlock', { challenge: y, presenceSig: p.dev.sign(ownerPresenceMessage(DESKTOP_UNLOCK_VERSION, p.id, HOST, y)) })).body.error).toBe('presence-invalid');
    const reasons = auditRows(c.dir).filter((r) => r.event === 'refused').map((r) => r.reason);
    expect(reasons).toEqual(expect.arrayContaining(['desktop:secure-transport-required', 'desktop:presence-key-missing', 'desktop:challenge-invalid', 'desktop:presence-invalid']));
  });

  it('off, or with no real PIN, it answers why', async () => {
    const off = setup({ mobilePairing: { multiRoute: { enabled: false }, ownerPresence: { enabled: false } } });
    expect((await send(off.app, off.pair(), 'POST', '/mobile/desktop-unlock/challenge', {})).body.error).toBe('owner-presence-off');
    for (const pin of [undefined, DASHBOARD_PIN_PLACEHOLDER, { secret: true }]) {
      const c = setup({ dashboardPin: pin });
      const r = await send(c.app, c.pair(), 'POST', '/mobile/desktop-unlock/challenge', {});
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('console-pin-not-set');
    }
  });
});

describe('the PIN page', () => {
  it('reveals exactly the PIN, tells the owner without it, once per 10 minutes, and audits every reveal', async () => {
    const c = setup();
    const p = c.pair();
    const r = await reveal(c.app, p);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({ pin: PIN, machine: 'Mac Studio', noticed: true });
    await new Promise((res) => setTimeout(res, 10));
    expect(c.dms).toHaveLength(1);
    expect(c.dms[0]).toContain('Mac Studio');
    expect(c.dms[0]).toContain('Justin iPhone');
    expect(c.dms[0]).not.toContain(PIN);
    expect((await reveal(c.app, p)).status).toBe(200);
    await new Promise((res) => setTimeout(res, 10));
    expect(c.dms).toHaveLength(1);
    const reasons = auditRows(c.dir).map((x) => x.reason);
    expect(reasons.filter((x) => x === 'pin-revealed')).toHaveLength(2);
    expect(reasons).toContain('pin-notice-sent');
    expect(reasons).toContain('pin-notice-covered');
    // The PIN, the session and the challenge never reach the audit.
    expect(auditText(c.dir)).not.toContain(PIN);
  });

  it('a notice that did not go out: no reveal, and the next try sends again', async () => {
    let ok = false;
    const c = setup({}, {});
    c.svc.deps.ownerDM = async (text: string) => { if (!ok) return null; c.dms.push(text); return 1; };
    const p = c.pair();
    const r = await reveal(c.app, p);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('notice-failed');
    expect(JSON.stringify(r.body)).not.toContain(PIN);
    expect(auditRows(c.dir).some((x) => x.reason === 'pin-revealed')).toBe(false);
    ok = true;
    const again = await reveal(c.app, p);
    expect(again.status).toBe(200);
    expect(c.dms).toHaveLength(1);
  });

  it('no private chat at all (no ownerDM, or no Telegram owner here): shown, audited, and said plainly', async () => {
    for (const opts of [{ ownerDM: false }, { ownerPresent: false }]) {
      const c = setup({}, opts);
      const r = await reveal(c.app, c.pair());
      expect(r.status, JSON.stringify(opts)).toBe(200);
      expect(r.body).toEqual({ pin: PIN, machine: 'Mac Studio', noticed: false });
      expect(c.dms).toHaveLength(0);
      expect(auditRows(c.dir).map((x) => x.reason)).toEqual(expect.arrayContaining(['pin-no-notice-channel', 'pin-revealed']));
    }
  });

  it('re-checks after the notice: a phone revoked, the switch turned off or the PIN changed meanwhile gets nothing', async () => {
    for (const change of ['revoke', 'off', 'pin'] as const) {
      const c = setup();
      const p = c.pair();
      c.svc.deps.ownerDM = async () => {
        if (change === 'revoke') c.svc.devices.revoke(p.id);
        if (change === 'off') c.config.mobilePairing = { multiRoute: { enabled: false }, ownerPresence: { enabled: false } };
        if (change === 'pin') c.config.dashboardPin = '999999';
        return 1;
      };
      const r = await reveal(c.app, p);
      expect(r.status, change).toBe(409);
      expect(r.body.error).toBe('changed-while-notifying');
      expect(JSON.stringify(r.body)).not.toMatch(/424242|999999/);
    }
  });

  it('a desktop-unlock signature or challenge never reveals the PIN', async () => {
    const c = setup();
    const p = c.pair();
    const x = await challengeFor(c.app, p, '/mobile/dashboard-pin/challenge');
    const r = await send(c.app, p, 'POST', '/mobile/dashboard-pin/reveal', { challenge: x, presenceSig: p.presence.sign(ownerPresenceMessage(DESKTOP_UNLOCK_VERSION, p.id, HOST, x)) });
    expect(r.body.error).toBe('presence-invalid');
    const d = await challengeFor(c.app, p, '/mobile/desktop-unlock/challenge');
    expect((await send(c.app, p, 'POST', '/mobile/dashboard-pin/reveal', { challenge: d, presenceSig: p.presence.sign(ownerPresenceMessage(PIN_REVEAL_VERSION, p.id, HOST, d)) })).body.error).toBe('challenge-invalid');
    expect(c.dms).toHaveLength(0);
  });
});
