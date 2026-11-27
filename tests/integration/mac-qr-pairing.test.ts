/**
 * Pair a computer from an owner phone (docs/specs/mac-qr-pairing.md §4) through the real HTTP
 * pipeline: the owner phone mints a code bound to the computer's key over its device-signed channel,
 * the computer redeems it, and the phone approves it with Face ID. A different key is refused, a team
 * phone cannot mint, and the bearer mint is unchanged.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, mountPublicMobilePairingRoutes, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { pairingApproveLine, pairingApproveMessage } from '../../src/server/mobilePairingApproval.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const HOST = 'echo-macqr.example.dev';
const SESSION = 'operator-session-token';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mac-qr-pairing.test.ts' });
});

function setup(opts: { telegramOwner?: boolean; approve?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqr-int-'));
  dirs.push(dir);
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    threadline: { ownerName: 'Justin' },
    mobilePairing: { multiRoute: { enabled: false }, ...(opts.approve === undefined ? {} : { approve: { enabled: opts.approve } }) },
  } as unknown as InstarConfig;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  const fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const dms: Array<{ text: string; decline: string; approve?: string }> = [];
  const lease = { held: true };
  const deps: MobilePairingDeps = {
    config, stateDir: dir, tunnel: () => ({ lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' } }), selfMachineId: 'm_self', fetchFn,
    ownerDM: async (text, decline, approve) => { dms.push({ text, decline, approve }); return 7; },
    telegramOwnerPresent: () => opts.telegramOwner === true,
    holdsLease: () => lease.held,
  };
  const svc = new MobilePairingService(deps);
  services.push(svc);
  svc.nativeOn = true;
  const pushes: unknown[] = [];
  svc.push = { notifyHere: (t: unknown) => pushes.push(t) } as unknown as typeof svc.push;
  mountPublicMobilePairingRoutes(app, svc);
  app.use(authMiddleware(() => config.authToken, 'echo', undefined, deviceAuthenticator(svc)));
  const poolCtx = { config, resolvePeerUrls: () => [], recordRopeResult: undefined, verifyDashboardOperatorSession: (t: string | undefined) => t === SESSION } as unknown as Parameters<typeof createMobilePairingRouter>[2];
  app.use(createMobilePairingRouter(svc, deps, poolCtx));
  return { app, svc, dms, lease, dir, config, pushes };
}
type Ctx = ReturnType<typeof setup>;

const bearer = (q: request.Test) => q.set('Authorization', 'Bearer tok-1');
const operator = (q: request.Test) => bearer(q).set('X-Instar-Operator-Session', SESSION);
let lastSignTime = 0;
function signed(app: express.Express, dev: ReturnType<typeof makeDevice>, deviceId: string, method: 'GET' | 'POST', p: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  lastSignTime = Math.max(Date.now(), lastSignTime + 1);
  const time = String(lastSignTime);
  const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
  const r = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
  r.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? r.send(raw.toString()) : r;
}
async function waiting(ctx: Ctx, extra: Record<string, unknown> = {}) {
  const m = await bearer(request(ctx.app).post('/mobile/pairing-codes')).send({ label: 'mine', ...extra });
  expect(m.status).toBe(200);
  const dev = makeDevice();
  const r = await request(ctx.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'iPhone', devicePublicKey: dev.publicKey });
  expect(r.status).toBe(200);
  return { dev, deviceId: r.body.deviceId as string, redeem: r };
}
/** An active owner phone with a presence key on file. */
async function ownerPhone(ctx: Ctx, opts: { presence?: boolean } = {}) {
  const p = await waiting(ctx);
  expect(ctx.svc.approvePending(p.deviceId, 'dashboard-pin')).toBe('approved');
  const presence = makeDevice();
  if (opts.presence !== false) expect(ctx.svc.devices.setPresenceKey(p.deviceId, presence.publicKey)).toBe('set');
  return { ...p, presence };
}
async function faceId(ctx: Ctx, phone: Awaited<ReturnType<typeof ownerPhone>>, id: string, action: 'approve' | 'decline', fingerprint: string) {
  const c = await signed(ctx.app, phone.dev, phone.deviceId, 'POST', `/mobile/pairing-requests/${id}/challenge`, { action });
  expect(c.status).toBe(200);
  const presenceSig = phone.presence.sign(pairingApproveMessage(phone.deviceId, HOST, c.body.challenge, pairingApproveLine(action, id, fingerprint)));
  return { challenge: c.body.challenge as string, presenceSig };
}

import { deviceFingerprint } from '../../src/core/MobileDeviceKeys.js';

async function phoneMint(ctx: Ctx, phone: Awaited<ReturnType<typeof ownerPhone>>, macKey: string, name = 'Studio Mac') {
  return signed(ctx.app, phone.dev, phone.deviceId, 'POST', '/mobile/pairing-codes', { forDevice: { publicKey: macKey, name } });
}
function redeemAs(ctx: Ctx, code: string, key: string) {
  return request(ctx.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code, deviceName: 'Studio Mac', devicePublicKey: key });
}

describe('an owner phone pairs a computer', () => {
  it('mints a code for the computer, the computer redeems it, and the phone approves it with Face ID', async () => {
    const ctx = setup();
    const phone = await ownerPhone(ctx);
    const mac = makeDevice();
    const m = await phoneMint(ctx, phone, mac.publicKey);
    expect(m.status).toBe(200);
    expect(m.body.link).toMatch(/^https:\/\/instar\.sh\/pair#v=1&o=/);
    expect(m.body.person).toMatchObject({ role: 'owner' });
    const r = await redeemAs(ctx, m.body.code, mac.publicKey);
    expect(r.status).toBe(200);
    const id = r.body.deviceId as string;
    // The phone finds the computer by the key it scanned, never by name.
    const list = await signed(ctx.app, phone.dev, phone.deviceId, 'GET', '/mobile/pairing-requests');
    const row = (list.body.waiting as Array<{ deviceId: string; fingerprint: string; label: string }>).find((w) => w.fingerprint === deviceFingerprint(mac.publicKey));
    expect(row?.deviceId).toBe(id);
    expect(row?.label).toBe('Studio Mac (added from iPhone)');
    expect((list.body.waiting as Array<{ deviceId: string; client: string }>).find((w) => w.deviceId === id)?.client).toBe('computer');
    // Nothing activated it yet: the code alone grants nothing.
    expect(ctx.svc.devices.get(id)!.status).toBe('pending');
    const fid = await faceId(ctx, phone, id, 'approve', row!.fingerprint);
    const a = await signed(ctx.app, phone.dev, phone.deviceId, 'POST', `/mobile/pairing-requests/${id}/approve`, fid);
    expect(a.status).toBe(200);
    expect(ctx.svc.devices.get(id)!.status).toBe('active');
  });

  it('refuses a redeem with any other key, and the code is spent', async () => {
    const ctx = setup();
    const phone = await ownerPhone(ctx);
    const mac = makeDevice();
    const m = await phoneMint(ctx, phone, mac.publicKey);
    const thief = makeDevice();
    const bad = await redeemAs(ctx, m.body.code, thief.publicKey);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('wrong-device');
    expect(ctx.svc.devices.list().some((d) => d.publicKey === thief.publicKey)).toBe(false);
    const again = await redeemAs(ctx, m.body.code, mac.publicKey);
    expect(again.status).toBe(403);
  });

  it('requires the computer key, and ignores a person or role in the body', async () => {
    const ctx = setup();
    const phone = await ownerPhone(ctx);
    const none = await signed(ctx.app, phone.dev, phone.deviceId, 'POST', '/mobile/pairing-codes', { forDevice: { name: 'x' } });
    expect(none.status).toBe(400);
    expect(none.body.error).toBe('bad-device-key');
    const mac = makeDevice();
    const m = await signed(ctx.app, phone.dev, phone.deviceId, 'POST', '/mobile/pairing-codes', { role: 'team', userId: 'u-x', forDevice: { publicKey: mac.publicKey } });
    expect(m.status).toBe(200);
    expect(m.body.person.role).toBe('owner');
  });

  it('a pending phone cannot mint', async () => {
    const ctx = setup();
    const p = await waiting(ctx);
    const mac = makeDevice();
    const r = await signed(ctx.app, p.dev, p.deviceId, 'POST', '/mobile/pairing-codes', { forDevice: { publicKey: mac.publicKey } });
    expect(r.status).toBeGreaterThanOrEqual(401);
    expect(r.status).toBeLessThan(500);
    expect(r.status).not.toBe(200);
  });

  it('the bearer mint is unchanged: no key binding, any key redeems', async () => {
    const ctx = setup();
    const m = await bearer(request(ctx.app).post('/mobile/pairing-codes')).send({ label: 'mine' });
    expect(m.status).toBe(200);
    const r = await redeemAs(ctx, m.body.code, makeDevice().publicKey);
    expect(r.status).toBe(200);
  });

  it('a device code lives 5 minutes; a phone mints at most 5 an hour and the bearer mint still works', async () => {
    const ctx = setup();
    const phone = await ownerPhone(ctx);
    const m = await phoneMint(ctx, phone, makeDevice().publicKey);
    const left = Date.parse(m.body.expiresAt) - Date.now();
    expect(left).toBeGreaterThan(4 * 60_000);
    expect(left).toBeLessThanOrEqual(5 * 60_000 + 1000);
    for (let i = 0; i < 4; i++) expect((await phoneMint(ctx, phone, makeDevice().publicKey)).status).toBe(200);
    const sixth = await phoneMint(ctx, phone, makeDevice().publicKey);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toBe('too-many-mints');
    // The phone's 5 leave the agent its own link-making (ownerPhone above used one bearer mint).
    expect((await bearer(request(ctx.app).post('/mobile/pairing-codes')).send({ label: 'x' })).status).toBe(200);
  });

  it('the Telegram message names a computer and where it was added from', async () => {
    const ctx = setup({ telegramOwner: true });
    const phone = await ownerPhone(ctx);
    const mac = makeDevice();
    const m = await phoneMint(ctx, phone, mac.publicKey);
    const before = ctx.dms.length;
    expect((await redeemAs(ctx, m.body.code, mac.publicKey)).status).toBe(200);
    const text = ctx.dms.slice(before).map((d) => d.text).join('\n');
    expect(text).toContain('A computer is asking to pair with echo (it calls itself Studio Mac (added from iPhone))');
    expect(text).toContain('Computer key:');
    expect(text).not.toContain('A phone is asking');
  });
});
