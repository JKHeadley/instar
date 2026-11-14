/** HTTP pipeline for mobile push (docs/specs/mobile-push.md). */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { MobilePushService, type ApnsTransport, type FcmTransport } from '../../src/core/MobilePush.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { RouteContext } from '../../src/server/routes.js';

const HOST = 'echo.example.dev';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) { s.push?.stop(); s.stop(); }
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-push-routes.test.ts' });
});
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const TOKEN = 'a'.repeat(64);
const READ = crypto.randomBytes(32).toString('hex');
const READ_HASH = crypto.createHash('sha256').update(READ).digest('hex');

const { privateKey: rsa } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = JSON.stringify({ project_id: 'instar-c1a64', client_email: 'push@instar-c1a64.iam.gserviceaccount.com', private_key: rsa.export({ format: 'pem', type: 'pkcs8' }).toString() });
const FCM_TOKEN = 'dGVzdA:APA91b' + 'Z'.repeat(140);

function setup(opts: { pushOff?: boolean; fcmKey?: string | null; machine?: string; peers?: () => Array<{ machineId: string; url: string; kind: 'last-known-url' }> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpush-int-'));
  dirs.push(dir);
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, mobilePairing: { ...(opts.pushOff ? { push: { enabled: false } } : {}), multiRoute: { enabled: false } } } as never;
  const deps: MobilePairingDeps = { config, stateDir: dir, holdsLease: () => true, selfMachineId: opts.machine ?? 'm_self' };
  const svc = new MobilePairingService(deps);
  services.push(svc);
  const sent: Array<Record<string, unknown>> = [];
  const transport: ApnsTransport = async (_e, _t, _h, body) => { sent.push(JSON.parse(body)); return { status: 200 }; };
  const fcmSent: Array<Record<string, any>> = [];
  const fcmTransport: FcmTransport = async (_p, _a, body) => { fcmSent.push(JSON.parse(body)); return { status: 200, tokenFieldViolation: false }; };
  svc.push = new MobilePushService({
    stateDir: dir, registry: svc.devices, agentId: 'echo', agentName: 'Echo', machineId: 'm_self',
    enabled: () => !opts.pushOff, credentials: () => ({ keyPem: KEY, keyId: 'K', teamId: 'T' }), transport,
    fcmKey: () => (opts.fcmKey === undefined ? SA : opts.fcmKey), fcmTransport, fcmOAuth: async () => ({ status: 200, accessToken: 'at' }),
  });
  const items: Record<string, { title: string; priority: string }> = { 'ATT-1': { title: 'Approve the new release <b>now</b>', priority: 'HIGH' } };
  const ctx = { config, telegram: { getAttentionItem: (id: string) => items[id] ?? null }, ...(opts.peers ? { resolvePeerUrls: opts.peers, recordRopeResult: undefined } : {}) } as unknown as RouteContext;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  app.use(createMobilePairingRouter(svc, deps, ctx));
  const dev = makeDevice();
  const created = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!created.ok) throw new Error('setup');
  svc.devices.applyConfirm(created.device.id, { ok: true });
  return { app, svc, dev, id: created.device.id, sent, fcmSent, dir };
}

let tick = 0;
function signed(c: ReturnType<typeof setup>, method: 'GET' | 'POST', p: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = c.dev.sign(canonicalString(c.id, HOST, method, p, time, raw));
  const r = method === 'GET' ? request(c.app).get(p) : request(c.app).post(p).set('Content-Type', 'application/json');
  r.set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? r.send(raw.toString()) : r;
}
const reg = (rev: number, extra: Record<string, unknown> = {}) => ({ token: TOKEN, environment: 'sandbox', notifyTokenHash: READ_HASH, revision: rev, ...extra });

describe('mobile push routes', () => {
  it('registers a token (device-signed), refuses bearer, stale and conflicting revisions, never lists the token', async () => {
    const c = setup();
    expect((await request(c.app).post('/mobile/device/push').set('Authorization', 'Bearer tok-1').send(reg(1))).status).toBe(403);
    const r = await signed(c, 'POST', '/mobile/device/push', reg(5));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, revision: 5, ready: true });
    expect((await signed(c, 'POST', '/mobile/device/push', reg(5))).status).toBe(200);
    expect((await signed(c, 'POST', '/mobile/device/push', { token: null, revision: 5 })).body.error).toBe('revision-conflict');
    expect((await signed(c, 'POST', '/mobile/device/push', reg(4))).body.error).toBe('stale-revision');
    expect((await signed(c, 'POST', '/mobile/device/push', reg(6, { token: 'XYZ' }))).status).toBe(400);
    const list = await request(c.app).get('/mobile/devices').set('Authorization', 'Bearer tok-1');
    expect(JSON.stringify(list.body)).not.toContain(TOKEN);
    expect((await signed(c, 'POST', '/mobile/device/push', { token: null, revision: 7 })).status).toBe(200);
    expect(c.svc.devices.get(c.id)!.pushToken).toBeUndefined();
  });

  it('attention title: notification read token or signature; wrong token, other route, revoked device refused', async () => {
    const c = setup();
    await signed(c, 'POST', '/mobile/device/push', reg(1));
    const ok = await request(c.app).get('/mobile/attention/ATT-1').set('X-Instar-Device', c.id).set('X-Instar-Notify-Token', READ);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ title: 'Approve the new release <b>now</b>'.slice(0, 160), priority: 'HIGH' });
    expect((await signed(c, 'GET', '/mobile/attention/ATT-1')).status).toBe(200);
    expect((await request(c.app).get('/mobile/attention/ATT-1').set('X-Instar-Device', c.id).set('X-Instar-Notify-Token', 'nope')).status).toBe(401);
    expect((await request(c.app).get('/mobile/devices').set('X-Instar-Device', c.id).set('X-Instar-Notify-Token', READ)).status).toBe(403);
    expect((await request(c.app).get('/mobile/attention/ATT-9').set('X-Instar-Device', c.id).set('X-Instar-Notify-Token', READ)).status).toBe(404);
    expect((await request(c.app).get('/mobile/attention/ATT-1?machine=m_unknown').set('X-Instar-Device', c.id).set('X-Instar-Notify-Token', READ)).status).toBe(404);
    c.svc.devices.revoke(c.id);
    expect((await request(c.app).get('/mobile/attention/ATT-1').set('X-Instar-Device', c.id).set('X-Instar-Notify-Token', READ)).status).toBe(401);
  });

  it('peer trigger: bearer only, 202, sends once, dedupes the same condition; gate off → 503', async () => {
    const c = setup();
    await signed(c, 'POST', '/mobile/device/push', reg(1));
    const body = { kind: 'item', itemId: 'ATT-1', dedupeKey: 'cond-1', sourceMachine: 'm_peer', priority: 'HIGH' };
    expect((await request(c.app).post('/mobile/push/notify').set('Authorization', 'Bearer tok-1').send(body)).status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.sent).toHaveLength(1);
    expect((c.sent[0] as any).instar).toMatchObject({ kind: 'item', itemId: 'ATT-1', machine: 'm_peer' });
    expect(JSON.stringify(c.sent[0])).not.toContain('Approve');
    await request(c.app).post('/mobile/push/notify').set('Authorization', 'Bearer tok-1').send(body);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.sent).toHaveLength(1);
    expect((await signed(c, 'POST', '/mobile/push/notify', body)).status).toBe(403);
    const st = await request(c.app).get('/mobile/push').set('Authorization', 'Bearer tok-1');
    expect(st.body).toMatchObject({ enabled: true, keyConfigured: true, fanout: { received: 2, deduped: 1 } });
    expect(st.body.devices[0]).toMatchObject({ sent24h: 1, throttled: false });
    const off = setup({ pushOff: true });
    expect((await request(off.app).post('/mobile/push/notify').set('Authorization', 'Bearer tok-1').send(body)).status).toBe(503);
  });

  it('onHubPost notifies own devices', async () => {
    const c = setup();
    await signed(c, 'POST', '/mobile/device/push', reg(1));
    c.svc.push!.onHubPost({ kind: 'notice', dedupeKey: 'notice:inbound-loss' });
    await new Promise((r) => setTimeout(r, 50));
    expect((c.sent[0] as any).instar).toMatchObject({ kind: 'notice' });
  });
});

// Android (docs/specs/mobile-android-app.md §2.3, §7 Integration).
describe('mobile push routes — Android (FCM)', () => {
  const fcmReg = (rev: number, extra: Record<string, unknown> = {}) => ({ provider: 'fcm', token: FCM_TOKEN, notifyTokenHash: READ_HASH, revision: rev, ...extra });

  it('an Android device registers an FCM token through the signed route; the answer has ready; status shows provider fcm', async () => {
    const c = setup();
    const r = await signed(c, 'POST', '/mobile/device/push', fcmReg(1));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, revision: 1, ready: true });
    const st = await request(c.app).get('/mobile/push').set('Authorization', 'Bearer tok-1');
    expect(st.body).toMatchObject({ fcmConfigured: true, pausedReasons: { apns: null, fcm: null } });
    expect(st.body.devices[0]).toMatchObject({ provider: 'fcm', environment: null });
    expect(JSON.stringify(st.body)).not.toContain(FCM_TOKEN);
    // A clear needs no provider and its answer has no ready.
    const clr = await signed(c, 'POST', '/mobile/device/push', { token: null, revision: 2 });
    expect(clr.body).toEqual({ ok: true, revision: 2 });
  });

  it('refuses a bad token, an environment on FCM and an unknown provider; ready false with no key', async () => {
    const c = setup();
    expect((await signed(c, 'POST', '/mobile/device/push', fcmReg(1, { token: 'short' }))).body.error).toBe('bad-token');
    expect((await signed(c, 'POST', '/mobile/device/push', fcmReg(1, { token: `${FCM_TOKEN} x` }))).body.error).toBe('bad-token');
    expect((await signed(c, 'POST', '/mobile/device/push', fcmReg(1, { environment: 'production' }))).body.error).toBe('bad-environment');
    expect((await signed(c, 'POST', '/mobile/device/push', fcmReg(1, { provider: 'hms' }))).body.error).toBe('bad-provider');
    const k = setup({ fcmKey: null });
    expect((await signed(k, 'POST', '/mobile/device/push', fcmReg(1))).body).toEqual({ ok: true, revision: 1, ready: false });
  });

  it('a posted attention item reaches the FCM double and an iPhone in the same run reaches the APNs double', async () => {
    const c = setup();
    await signed(c, 'POST', '/mobile/device/push', fcmReg(1));
    const iphone = makeDevice();
    const created = c.svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: iphone.publicKey, host: HOST });
    if (!created.ok) throw new Error('setup');
    c.svc.devices.applyConfirm(created.device.id, { ok: true });
    c.svc.devices.setPush(created.device.id, { token: TOKEN, environment: 'sandbox', notifyTokenHash: READ_HASH, revision: 1 });
    const body = { kind: 'item', itemId: 'ATT-1', dedupeKey: 'cond-a', sourceMachine: 'm_peer' };
    expect((await request(c.app).post('/mobile/push/notify').set('Authorization', 'Bearer tok-1').send(body)).status).toBe(202);
    await new Promise((r) => setTimeout(r, 100));
    expect(c.sent).toHaveLength(1);
    expect(c.fcmSent).toHaveLength(1);
    expect(c.fcmSent[0]!.message.token).toBe(FCM_TOKEN);
    expect(JSON.parse(c.fcmSent[0]!.message.data.instar)).toMatchObject({ kind: 'item', itemId: 'ATT-1' });
    expect(JSON.stringify(c.fcmSent[0])).not.toContain('Approve');
  });

  it('revoke clears an FCM token; a Bearer register is refused', async () => {
    const c = setup();
    expect((await request(c.app).post('/mobile/device/push').set('Authorization', 'Bearer tok-1').send(fcmReg(1))).status).toBe(403);
    await signed(c, 'POST', '/mobile/device/push', fcmReg(1));
    c.svc.devices.revoke(c.id);
    expect(c.svc.devices.get(c.id)!.pushToken).toBeUndefined();
    expect(c.svc.devices.get(c.id)!.pushProvider).toBeUndefined();
  });

  it('recheck: Bearer only, fcm only, answers per machine, at most 6 an hour', async () => {
    const c = setup();
    const post = (b: unknown) => request(c.app).post('/mobile/push/recheck').set('Authorization', 'Bearer tok-1').send(b as object);
    expect((await signed(c, 'POST', '/mobile/push/recheck', { provider: 'fcm' })).status).toBe(403);
    expect((await post({ provider: 'apns' })).status).toBe(400);
    expect((await post({ provider: 'fcm', extra: 1 })).status).toBe(400);
    expect((await post({ provider: 'fcm', forwarded: false })).status).toBe(400);
    const r = await post({ provider: 'fcm' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ machines: [{ machine: 'm_self', armed: false, reason: 'not-paused' }], unreachable: [] });
    expect((await post({ provider: 'fcm', forwarded: true })).body.machines).toHaveLength(1);
    for (let i = 0; i < 4; i++) await post({ provider: 'fcm' });
    expect((await post({ provider: 'fcm' })).status).toBe(429);
    const off = setup({ pushOff: true });
    expect((await request(off.app).post('/mobile/push/recheck').set('Authorization', 'Bearer tok-1').send({ provider: 'fcm' })).status).toBe(503);
  });
});

describe('mobile push recheck across two machines', () => {
  const servers: Server[] = [];
  afterAll(() => { for (const s of servers) s.close(); });
  const listen = (app: express.Express) => new Promise<string>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(`http://localhost:${(s.address() as { port: number }).port}`));
    servers.push(s);
  });

  it('trials used up on B, a recheck on A clears B, and each machine applies it exactly once', async () => {
    let urlA = ''; let urlB = '';
    const a = setup({ machine: 'm_a', peers: () => [{ machineId: 'm_b', url: urlB, kind: 'last-known-url' }] });
    const b = setup({ machine: 'm_b', peers: () => [{ machineId: 'm_a', url: urlA, kind: 'last-known-url' }] });
    urlA = await listen(a.app); urlB = await listen(b.app);
    // B: an FCM phone, paused with all 6 trials refused.
    await signed(b, 'POST', '/mobile/device/push', { provider: 'fcm', token: FCM_TOKEN, notifyTokenHash: READ_HASH, revision: 1 });
    const credHash = crypto.createHash('sha256').update(SA).digest('hex');
    fs.mkdirSync(path.join(b.dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(b.dir, 'state', 'mobile-push-state.json'), JSON.stringify({
      devices: { [b.id]: { sendLog: [], urgentLog: [], lastSendAt: null, pending: { count: 1, hasUrgent: false }, dueAt: Date.now() - 1000, backoffUntil: null, lastSend: null } },
      dedupe: {}, paused: null, pausedFcm: { reason: 'permission-denied', credHash, at: Date.now() - 40 * 3_600_000, checkedAt: Date.now(), refusedTrials: 6, nextTrialAt: null }, fcmKeyHash: credHash,
      fanout: { sent: 0, received: 0, deduped: 0, refused: 0 },
    }));
    const pushB = b.svc.push!;
    (pushB as unknown as { state: null }).state = null; // reload from disk
    const calls = { a: 0, b: 0 };
    const wrap = (svc: MobilePushService, k: 'a' | 'b') => { const f = svc.recheckFcm.bind(svc); svc.recheckFcm = () => { calls[k]++; return f(); }; };
    wrap(a.svc.push!, 'a'); wrap(pushB, 'b');
    await pushB.tick();
    expect(b.fcmSent).toHaveLength(0); // trials used up: the held fold waits
    const r = await request(a.app).post('/mobile/push/recheck').set('Authorization', 'Bearer tok-1').send({ provider: 'fcm' });
    expect(r.status).toBe(200);
    expect(r.body.unreachable).toEqual([]);
    expect(r.body.machines).toEqual([{ machine: 'm_a', armed: false, reason: 'not-paused' }, { machine: 'm_b', armed: true }]);
    expect(calls).toEqual({ a: 1, b: 1 });
    await pushB.tick(); // the held fold goes as the trial and clears the pause
    expect(b.fcmSent).toHaveLength(1);
    expect((pushB.status() as any).pausedReasons.fcm).toBeNull();
    // B at its own limit (6 an hour) is listed as rate-limited, not unreachable.
    for (let i = 0; i < 5; i++) await request(b.app).post('/mobile/push/recheck').set('Authorization', 'Bearer tok-1').send({ provider: 'fcm', forwarded: true });
    const limited = await request(a.app).post('/mobile/push/recheck').set('Authorization', 'Bearer tok-1').send({ provider: 'fcm' });
    expect(limited.body.unreachable).toEqual([]);
    expect(limited.body.machines[1]).toEqual({ machine: 'm_b', armed: false, reason: 'rate-limited' });
  });
});
