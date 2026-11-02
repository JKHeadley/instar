/**
 * HTTP pipeline for pairing and push without Telegram (docs/specs/mobile-native-conversations.md
 * §4.4, §4.7 — increment 3). With no Telegram owner and native conversations on, redeem answers
 * `{status: "pending", approval: "dashboard"}`; the 6-digit code is shown ONLY to a dashboard
 * operator session (never to the Bearer token alone, never to a device); confirm records
 * `approvedVia: "dashboard-pin"`; a lease move does not expire such a device; a restart does.
 * The Telegram path keeps working where a Telegram owner exists. A peer's reply push trigger is
 * accepted only with a strict app conversation key.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, mountPublicMobilePairingRoutes, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { MobilePushService, type PushTrigger } from '../../src/core/MobilePush.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const HOST = 'echo-dash.example.dev';
const SESSION = 'operator-session-token-123';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-dashboard-pairing.test.ts' });
});

function setup(opts: { nativeOn?: boolean; telegramOwner?: boolean; withAdapter?: boolean; dir?: string } = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-int-'));
  if (!opts.dir) dirs.push(dir);
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    mobilePairing: { multiRoute: { enabled: false } },
  } as unknown as InstarConfig;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  const fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const dms: string[] = [];
  const lease = { held: true };
  const deps: MobilePairingDeps = {
    config, stateDir: dir, tunnel: () => ({ lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' } }), selfMachineId: 'm_self', fetchFn,
    ...(opts.withAdapter ? { ownerDM: async (text: string) => { dms.push(text); return 7; } } : {}),
    telegramOwnerPresent: () => opts.telegramOwner === true,
    holdsLease: () => lease.held,
  };
  const svc = new MobilePairingService(deps);
  services.push(svc);
  svc.nativeOn = opts.nativeOn ?? true;
  const fanned: PushTrigger[] = [];
  const sent: unknown[] = [];
  svc.push = new MobilePushService({
    stateDir: dir, registry: svc.devices, agentId: 'echo', agentName: 'Echo', machineId: 'm_self', enabled: () => true,
    credentials: () => null, transport: async (_e, _t, _h, body) => { sent.push(JSON.parse(body)); return { status: 200 }; },
    fanOut: (t) => fanned.push(t),
  });
  mountPublicMobilePairingRoutes(app, svc);
  app.use(authMiddleware(() => config.authToken, 'echo', undefined, deviceAuthenticator(svc)));
  const poolCtx = { config, resolvePeerUrls: () => [], recordRopeResult: undefined, verifyDashboardOperatorSession: (t: string | undefined) => t === SESSION } as unknown as Parameters<typeof createMobilePairingRouter>[2];
  app.use(createMobilePairingRouter(svc, deps, poolCtx));
  app.get('/sessions', (_req, res) => { res.json([]); });
  return { app, svc, dms, lease, dir, fanned };
}

const bearer = (q: request.Test) => q.set('Authorization', 'Bearer tok-1');
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
async function redeemNew(app: express.Express) {
  const m = await bearer(request(app).post('/mobile/pairing-codes')).send({ label: 'mine' });
  expect(m.status).toBe(200);
  const dev = makeDevice();
  const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'iPhone', devicePublicKey: dev.publicKey });
  return { dev, r, deviceId: r.body.deviceId as string };
}
const approvals = (app: express.Express, session?: string) => {
  const q = bearer(request(app).get('/mobile/pairing-approvals'));
  return session ? q.set('X-Instar-Operator-Session', session) : q;
};

describe('pairing without Telegram (dashboard path)', () => {
  it('redeem answers pending/dashboard at once; the code is shown only to an operator session; confirm records dashboard-pin', async () => {
    const ctx = setup();
    const { dev, r, deviceId } = await redeemNew(ctx.app);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deviceId, agentName: 'echo', status: 'pending', approval: 'dashboard' });
    expect(ctx.dms).toHaveLength(0);

    // Bearer alone: refused. A wrong session: refused. A device: not on its allowlist.
    expect((await approvals(ctx.app)).status).toBe(403);
    expect((await approvals(ctx.app, 'not-the-session')).status).toBe(403);
    expect((await signed(ctx.app, dev, deviceId, 'GET', '/mobile/pairing-approvals')).status).toBe(403);
    // The Bearer device list never carries the code, nor a pending fingerprint.
    const list = await bearer(request(ctx.app).get('/mobile/devices'));
    expect(JSON.stringify(list.body)).not.toMatch(/"code"/);

    const a = await approvals(ctx.app, SESSION);
    expect(a.status).toBe(200);
    expect(a.headers['cache-control']).toBe('no-store');
    expect(a.body.approval).toBe('dashboard');
    expect(a.body.approvals).toHaveLength(1);
    const row = a.body.approvals[0];
    expect(row).toMatchObject({ deviceId, deviceName: 'iPhone', label: 'mine' });
    expect(row.code).toMatch(/^\d{6}$/);
    expect(row.fingerprint).toBe(ctx.svc.devices.get(deviceId)!.fingerprint);
    // The plaintext is never written to disk.
    for (const f of fs.readdirSync(ctx.dir, { recursive: true }) as string[]) {
      const p = path.join(ctx.dir, f);
      if (fs.statSync(p).isFile()) expect(fs.readFileSync(p, 'utf8')).not.toContain(row.code);
    }

    // The phone status says where the code is.
    expect((await signed(ctx.app, dev, deviceId, 'GET', '/mobile/device')).body).toMatchObject({ status: 'pending', approval: 'dashboard' });
    const ok = await signed(ctx.app, dev, deviceId, 'POST', '/mobile/device/confirm', { code: row.code });
    expect(ok.body).toEqual({ status: 'active' });
    expect(ctx.svc.devices.get(deviceId)!.approvedVia).toBe('dashboard-pin');
    expect((await signed(ctx.app, dev, deviceId, 'GET', '/mobile/device')).body).toMatchObject({ status: 'active', approvedVia: 'dashboard-pin' });
    expect((await approvals(ctx.app, SESSION)).body.approvals).toHaveLength(0); // consumed
    expect((await signed(ctx.app, dev, deviceId, 'GET', '/sessions')).status).toBe(200);
  });

  it('a lease move does not expire a dashboard-path device; confirm needs no lease', async () => {
    const ctx = setup();
    const { dev, deviceId } = await redeemNew(ctx.app);
    const code = (await approvals(ctx.app, SESSION)).body.approvals[0].code;
    ctx.lease.held = false;
    ctx.svc.leaseTick();
    expect(ctx.svc.devices.get(deviceId)!.status).toBe('pending');
    const ok = await signed(ctx.app, dev, deviceId, 'POST', '/mobile/device/confirm', { code });
    expect(ok.body).toEqual({ status: 'active' });
  });

  it('wrong codes still count: three distinct wrong codes decline and the code leaves the card', async () => {
    const ctx = setup();
    const { dev, deviceId } = await redeemNew(ctx.app);
    const right = (await approvals(ctx.app, SESSION)).body.approvals[0].code as string;
    const wrongs = ['111111', '222222', '333333', '444444'].filter((c) => c !== right).slice(0, 3);
    for (const w of wrongs.slice(0, 2)) expect((await signed(ctx.app, dev, deviceId, 'POST', '/mobile/device/confirm', { code: w })).status).toBe(403);
    expect((await signed(ctx.app, dev, deviceId, 'POST', '/mobile/device/confirm', { code: wrongs[2] })).body.error).toBe('declined');
    expect((await approvals(ctx.app, SESSION)).body.approvals).toHaveLength(0);
  });

  it('the operator declines from the dashboard; the phone can then never confirm', async () => {
    const ctx = setup();
    const { dev, deviceId } = await redeemNew(ctx.app);
    const code = (await approvals(ctx.app, SESSION)).body.approvals[0].code;
    expect((await bearer(request(ctx.app).post(`/mobile/pairing-approvals/${deviceId}/decline`)).send({})).status).toBe(403); // Bearer alone
    const d = await bearer(request(ctx.app).post(`/mobile/pairing-approvals/${deviceId}/decline`)).set('X-Instar-Operator-Session', SESSION).send({});
    expect(d.body).toEqual({ declined: true });
    expect(ctx.svc.devices.get(deviceId)!.status).toBe('declined');
    // A declined device is refused at authentication; the right code can never activate it.
    const after = await signed(ctx.app, dev, deviceId, 'POST', '/mobile/device/confirm', { code });
    expect(after.status).toBe(401);
    expect(ctx.svc.devices.get(deviceId)!.status).toBe('declined');
  });

  it('an unreadable registry drops the shown code AND the confirmable code: nothing live is left behind', async () => {
    const ctx = setup();
    const { dev, deviceId } = await redeemNew(ctx.app);
    const code = (await approvals(ctx.app, SESSION)).body.approvals[0].code as string;
    const realGet = ctx.svc.devices.get.bind(ctx.svc.devices);
    ctx.svc.devices.get = () => { throw new Error('registry unreadable'); };
    expect(ctx.svc.isDashboardPending(deviceId)).toBe(false); // prune ran against the failing read
    ctx.svc.devices.get = realGet;
    // The registry reads again and the device is still pending, but its code was voided with it.
    expect(ctx.svc.devices.get(deviceId)!.status).toBe('pending');
    expect(ctx.svc.confirm.check(deviceId, code).result).toBe('none');
    const r = await signed(ctx.app, dev, deviceId, 'POST', '/mobile/device/confirm', { code });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('expired');
    expect(ctx.svc.devices.get(deviceId)!.status).toBe('pending'); // not activated
  });

  it('a restart loses the code: the pending device expires and the card is empty', async () => {
    const ctx = setup();
    const { deviceId } = await redeemNew(ctx.app);
    const after = setup({ dir: ctx.dir });
    expect(after.svc.devices.get(deviceId)!.status).toBe('expired');
    expect((await approvals(after.app, SESSION)).body.approvals).toEqual([]);
  });
});

describe('pairing path selection', () => {
  it('a Telegram owner present: the code goes to the private chat, not the dashboard (unchanged)', async () => {
    const ctx = setup({ withAdapter: true, telegramOwner: true });
    const { r } = await redeemNew(ctx.app);
    expect(r.body).toMatchObject({ status: 'pending', approval: 'telegram' });
    expect(ctx.dms).toHaveLength(1);
    expect((await approvals(ctx.app, SESSION)).body).toEqual({ approval: 'telegram', approvals: [] });
  });

  it('a Telegram adapter with no known owner falls back to the dashboard', async () => {
    const ctx = setup({ withAdapter: true, telegramOwner: false });
    const { r } = await redeemNew(ctx.app);
    expect(r.body.approval).toBe('dashboard');
    expect(ctx.dms).toHaveLength(0);
  });

  it('native conversations off and no Telegram: the old 409 approval-unavailable', async () => {
    const ctx = setup({ nativeOn: false });
    const { r } = await redeemNew(ctx.app);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('approval-unavailable');
    expect(ctx.svc.devices.list()).toHaveLength(0);
  });
});

describe('push trigger for app replies (peer route)', () => {
  const KEY = '2f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
  it('accepts a reply trigger with a strict conversation key; refuses one without', async () => {
    const ctx = setup();
    const ok = await bearer(request(ctx.app).post('/mobile/push/notify')).send({ kind: 'reply', conversationKey: KEY, dedupeKey: 'app-reply:m1', sourceMachine: 'peer' });
    expect(ok.status).toBe(202);
    const bad = await bearer(request(ctx.app).post('/mobile/push/notify')).send({ kind: 'reply', conversationKey: 'NOT-A-UUID', dedupeKey: 'app-reply:m2', sourceMachine: 'peer' });
    expect(bad.status).toBe(400);
    const none = await bearer(request(ctx.app).post('/mobile/push/notify')).send({ kind: 'reply', dedupeKey: 'app-reply:m3', sourceMachine: 'peer' });
    expect(none.status).toBe(400);
  });
});
