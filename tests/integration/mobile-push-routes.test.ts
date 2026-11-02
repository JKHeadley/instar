/** HTTP pipeline for mobile push (docs/specs/mobile-push.md). */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { MobilePushService, type ApnsTransport } from '../../src/core/MobilePush.js';
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

function setup(opts: { pushOff?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpush-int-'));
  dirs.push(dir);
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, mobilePairing: { ...(opts.pushOff ? { push: { enabled: false } } : {}), multiRoute: { enabled: false } } } as never;
  const deps: MobilePairingDeps = { config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' };
  const svc = new MobilePairingService(deps);
  services.push(svc);
  const sent: Array<Record<string, unknown>> = [];
  const transport: ApnsTransport = async (_e, _t, _h, body) => { sent.push(JSON.parse(body)); return { status: 200 }; };
  svc.push = new MobilePushService({
    stateDir: dir, registry: svc.devices, agentId: 'echo', agentName: 'Echo', machineId: 'm_self',
    enabled: () => !opts.pushOff, credentials: () => ({ keyPem: KEY, keyId: 'K', teamId: 'T' }), transport,
  });
  const items: Record<string, { title: string; priority: string }> = { 'ATT-1': { title: 'Approve the new release <b>now</b>', priority: 'HIGH' } };
  const ctx = { config, telegram: { getAttentionItem: (id: string) => items[id] ?? null } } as unknown as RouteContext;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  app.use(createMobilePairingRouter(svc, deps, ctx));
  const dev = makeDevice();
  const created = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!created.ok) throw new Error('setup');
  svc.devices.applyConfirm(created.device.id, { ok: true });
  return { app, svc, dev, id: created.device.id, sent };
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
    expect(r.body).toEqual({ ok: true, revision: 5 });
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
