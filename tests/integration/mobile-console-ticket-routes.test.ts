/**
 * HTTP pipeline for console sign-in from an owner phone (docs/specs/mobile-console-device-signin.md):
 * the real device authenticator and allowlist, the real pairing router, the public redeem route and
 * the bearer gate, on an express app wired the way AgentServer wires them.
 */
import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import {
  MobilePairingService, createMobilePairingRouter, deviceAuthenticator, mountPublicMobilePairingRoutes,
  type MobilePairingDeps,
} from '../../src/server/mobilePairingRoutes.js';
import { mountConsoleTicketRedeemRoute, presenceEnrollMessage, presenceMessage } from '../../src/server/mobileConsoleTicket.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const OWNER = 7812716706;
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-console-ticket-routes.test.ts' });
});

const USERS = [
  { id: 'ann', name: 'Ann', channels: [], permissions: ['user'], telegramUserId: OWNER },
  { id: 'justin', name: 'Justin', channels: [], permissions: ['user'], telegramUserId: 555 },
];

function setup(opts: { dir?: string; consoleTicket?: { enabled?: boolean }; failAudit?: boolean } = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mct-int-'));
  if (!opts.dir) dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(USERS));
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    sessions: {}, scheduler: {},
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    mobilePairing: { multiRoute: { enabled: false }, ...(opts.consoleTicket ? { consoleTicket: opts.consoleTicket } : {}) },
  };
  const degraded: string[] = [];
  const deps: MobilePairingDeps = {
    config: config as never, stateDir: dir, holdsLease: () => true, selfMachineId: 'm1',
    tunnel: () => ({ lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' } }),
    ownerDM: async () => 1, telegramOwnerId: () => OWNER,
    reportDegradation: (what) => { degraded.push(what); },
  };
  const pairing = new MobilePairingService(deps);
  services.push(pairing);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  mountPublicMobilePairingRoutes(app, pairing);
  mountConsoleTicketRedeemRoute(app, pairing, () => config.authToken);
  app.use(authMiddleware(() => config.authToken, 'echo', undefined, deviceAuthenticator(pairing)));
  app.get('/sessions', (_req, res) => { res.json({ sessions: [] }); });
  app.use(createMobilePairingRouter(pairing, deps));
  if (opts.failAudit) {
    // A directory where the audit file should be: every append fails.
    fs.mkdirSync(path.join(dir, 'state', 'mobile-console-tickets.jsonl'), { recursive: true });
  }
  return { app, pairing, dir, config, degraded };
}
type Env = ReturnType<typeof setup>;

function phone(e: Env, person?: { userId: string; role: 'msp' }) {
  const dev = makeDevice();
  const presence = makeDevice();
  const c = e.pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
  if (!c.ok) throw new Error('setup');
  e.pairing.devices.applyConfirm(c.device.id, { ok: true });
  return { dev, presence, deviceId: c.device.id };
}
type Phone = ReturnType<typeof phone>;

let tick = 0;
function signedRequest(e: Env, p: Phone, url: string, body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = p.dev.sign(canonicalString(p.deviceId, HOST, 'POST', url, time, raw));
  return { raw, time, sig, send: () => request(e.app).post(url).set('Host', HOST)
    .set('X-Instar-Device', p.deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig)
    .set('Content-Type', 'application/json').send(raw.toString()) };
}
const signed = (e: Env, p: Phone, url: string, body: unknown = {}) => signedRequest(e, p, url, body).send();

async function enroll(e: Env, p: Phone, key = p.presence) {
  return signed(e, p, '/mobile/device/presence-key', { publicKey: key.publicKey, proof: key.sign(presenceEnrollMessage(p.deviceId, HOST, key.publicKey)) });
}
async function mint(e: Env, p: Phone) {
  const c = await signed(e, p, '/mobile/console-ticket/challenge');
  expect(c.status).toBe(200);
  const presenceSig = p.presence.sign(presenceMessage(p.deviceId, HOST, c.body.challenge));
  return signed(e, p, '/mobile/console-ticket', { challenge: c.body.challenge, presenceSig });
}
const redeem = (e: Env, ticket: unknown, host = HOST) => request(e.app).post('/dashboard/console-ticket').set('Host', host).send({ ticket });
const audit = (e: Env) => fs.readFileSync(path.join(e.dir, 'state', 'mobile-console-tickets.jsonl'), 'utf8');

describe('console ticket routes', () => {
  it('enrolls once, mints with the presence key, and redeems exactly once for the API token', async () => {
    const e = setup();
    const p = phone(e);
    expect((await enroll(e, p)).status).toBe(200);
    expect((await enroll(e, p)).status).toBe(200); // same key: idempotent
    const unproven = await signed(e, p, '/mobile/device/presence-key', { publicKey: makeDevice().publicKey, proof: p.presence.sign('x') });
    expect(unproven.status).toBe(400);
    expect(unproven.body.error).toBe('presence-proof-invalid');
    expect((await signed(e, p, '/mobile/device/presence-key', { publicKey: 'not-a-key', proof: 'x' })).status).toBe(400);
    expect((await enroll(e, p, p.dev)).status).toBe(400); // the device key itself is not a presence key
    const conflict = await enroll(e, p, makeDevice());
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('presence-key-set');

    const m = await mint(e, p);
    expect(m.status).toBe(200);
    expect(m.headers['cache-control']).toBe('no-store');
    expect(m.body.redeemOrigin).toBe(`https://${HOST}`);
    expect(m.body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const r = await redeem(e, m.body.ticket);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ token: 'tok-1' }); // only the token: no operator session
    expect(r.headers['cache-control']).toBe('no-store');
    const sessions = await request(e.app).get('/sessions').set('Authorization', `Bearer ${r.body.token}`);
    expect(sessions.status).toBe(200);

    expect((await redeem(e, m.body.ticket)).status).toBe(401); // single use

    const log = audit(e);
    expect(log).toContain('"event":"presence-key-set"');
    expect(log).toContain('"event":"minted"');
    expect(log).toContain('"event":"redeemed"');
    expect(log).not.toContain(m.body.ticket);
    expect(log).not.toContain('tok-1');
  });

  it('refuses a mint without a presence key, with a bad presence signature, or a replayed mint request', async () => {
    const e = setup();
    const p = phone(e);
    const c0 = await signed(e, p, '/mobile/console-ticket/challenge');
    const noKey = await signed(e, p, '/mobile/console-ticket', { challenge: c0.body.challenge, presenceSig: 'x' });
    expect(noKey.status).toBe(409);
    expect(noKey.body.error).toBe('presence-key-missing');
    await enroll(e, p);

    const c = await signed(e, p, '/mobile/console-ticket/challenge');
    const wrong = makeDevice().sign(presenceMessage(p.deviceId, HOST, c.body.challenge));
    const bad = await signed(e, p, '/mobile/console-ticket', { challenge: c.body.challenge, presenceSig: wrong });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('presence-invalid');

    // The challenge was consumed by the failed attempt; a signed mint replayed verbatim is refused.
    const c2 = await signed(e, p, '/mobile/console-ticket/challenge');
    const req = signedRequest(e, p, '/mobile/console-ticket', { challenge: c2.body.challenge, presenceSig: p.presence.sign(presenceMessage(p.deviceId, HOST, c2.body.challenge)) });
    expect((await req.send()).status).toBe(200);
    const replay = await request(e.app).post('/mobile/console-ticket').set('Host', HOST)
      .set('X-Instar-Device', p.deviceId).set('X-Instar-Device-Time', req.time).set('X-Instar-Device-Sig', req.sig)
      .set('Content-Type', 'application/json').send(req.raw.toString());
    expect(replay.status).toBe(401);
  });

  it('a challenge or ticket from before a restart is unknown afterwards, and a ticket is unknown on another machine', async () => {
    const e = setup();
    const p = phone(e);
    await enroll(e, p);
    const c = await signed(e, p, '/mobile/console-ticket/challenge');
    const m = await mint(e, p);
    expect(m.status).toBe(200);
    // Same state directory, a fresh process: the registry (and presence key) survive, memory does not.
    const restarted = setup({ dir: e.dir });
    const presenceSig = p.presence.sign(presenceMessage(p.deviceId, HOST, c.body.challenge));
    const stale = await signed(restarted, p, '/mobile/console-ticket', { challenge: c.body.challenge, presenceSig });
    expect(stale.status).toBe(401);
    expect(stale.body.error).toBe('challenge-invalid');
    expect((await redeem(restarted, m.body.ticket)).status).toBe(401);
    // A different machine never minted it either.
    const other = setup();
    expect((await redeem(other, m.body.ticket)).status).toBe(401);
  });

  it('refuses a bearer caller and an MSP phone at mint; refuses a revoked phone at redeem', async () => {
    const e = setup();
    const bearer = await request(e.app).post('/mobile/console-ticket/challenge').set('Authorization', 'Bearer tok-1').send({});
    expect(bearer.status).toBe(403);
    expect(bearer.body.error).toBe('device-signature-required');

    const msp = phone(e, { userId: 'justin', role: 'msp' });
    const refused = await signed(e, msp, '/mobile/console-ticket/challenge');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('owner-phone-required');
    expect((await enroll(e, msp)).status).toBe(403);

    const p = phone(e);
    await enroll(e, p);
    const m = await mint(e, p);
    expect(m.status).toBe(200);
    e.pairing.devices.revoke(p.deviceId);
    const r = await redeem(e, m.body.ticket);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('device-not-active');
    expect(audit(e)).toContain('"reason":"device-not-active"');
  });

  it('binds the ticket to the Host it was minted for', async () => {
    const e = setup();
    const p = phone(e);
    await enroll(e, p);
    const m = await mint(e, p);
    const r = await redeem(e, m.body.ticket, 'other-front.example.dev');
    expect(r.status).toBe(401);
    expect(audit(e)).toContain('"reason":"host-mismatch"');
    // Normalized like the device authenticator: a :443 suffix is the same Host.
    const m2 = await mint(e, p);
    expect((await redeem(e, m2.body.ticket, `${HOST}:443`)).status).toBe(200);
  });

  it('the switch off answers 503 on every route, including a ticket minted before it was turned off', async () => {
    const e = setup();
    const p = phone(e);
    await enroll(e, p);
    const m = await mint(e, p);
    (e.config.mobilePairing as Record<string, unknown>).consoleTicket = { enabled: false };
    expect((await signed(e, p, '/mobile/console-ticket/challenge')).status).toBe(503);
    expect((await enroll(e, p)).status).toBe(503);
    expect((await redeem(e, m.body.ticket)).status).toBe(503);
  });

  it('only POST on the exact redeem path skips the bearer gate', async () => {
    const e = setup();
    expect((await request(e.app).get('/dashboard/console-ticket')).status).toBe(401);
    expect((await redeem(e, 'not-a-ticket')).status).toBe(401);
    expect((await redeem(e, 42)).status).toBe(400);
  });

  it('a flood of unknown tickets is throttled but never stops a real ticket', async () => {
    const e = setup();
    const p = phone(e);
    await enroll(e, p);
    const m = await mint(e, p);
    let throttled = 0;
    for (let i = 0; i < 15; i++) if ((await redeem(e, 'A'.repeat(43))).status === 429) throttled++;
    expect(throttled).toBeGreaterThan(0);
    expect((await redeem(e, m.body.ticket)).status).toBe(200);
  });

  it('a failing audit write is reported and does not fail the request', async () => {
    const e = setup({ failAudit: true });
    const p = phone(e);
    expect((await enroll(e, p)).status).toBe(200);
    const m = await mint(e, p);
    expect(m.status).toBe(200);
    expect((await redeem(e, m.body.ticket)).status).toBe(200);
    expect(e.degraded).toContain('MobileConsoleTicket.audit');
  });
});
