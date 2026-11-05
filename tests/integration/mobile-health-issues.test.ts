/**
 * HTTP pipeline for GET /mobile/health-issues (docs/specs/mobile-health-issues.md) through the production
 * authMiddleware + deviceAuthenticator: an owner phone and the bearer are served; an MSP phone, a revoked
 * phone, an unsigned or tampered request and a POST are refused. /health failing says so, never "healthy".
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { mountMobileHealthRoutes } from '../../src/server/mobileHealthRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const PATH = '/mobile/health-issues';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-health-issues.test.ts' });
});

function setup(readHealth: () => Promise<{ status: number; body: unknown }>, events: Array<Record<string, unknown>> = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhealth-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } } } as unknown as MobilePairingDeps['config'];
  const svc = new MobilePairingService({ config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' });
  services.push(svc);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  const router = express.Router();
  mountMobileHealthRoutes(router, { readHealth, recentEvents: () => events, bearerOk: (req) => req.headers.authorization === 'Bearer tok-1' });
  app.use(router);
  const pair = (person?: { userId: string; role: 'msp' }) => {
    const dev = makeDevice();
    const created = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
    if (!created.ok) throw new Error('setup');
    svc.devices.applyConfirm(created.device.id, { ok: true });
    return { dev, id: created.device.id };
  };
  return { app, svc, pair };
}

let tick = 0;
function signedGet(app: express.Express, d: { dev: ReturnType<typeof makeDevice>; id: string }) {
  const time = String(Date.now() + (tick++ % 1000));
  const sig = d.dev.sign(canonicalString(d.id, HOST, 'GET', PATH, time, undefined));
  return request(app).get(PATH).set('X-Instar-Device', d.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
}
const healthy = async () => ({ status: 200, body: { status: 'ok', uptimeHuman: '2h' } });
const degraded = async () => ({ status: 200, body: { status: 'degraded', uptimeHuman: '2h', sessions: { current: 3, max: 25 } } });

describe('GET /mobile/health-issues', () => {
  it('an owner phone reads the sorted answer, with no raw reason and no /health internals', async () => {
    const { app, pair } = setup(degraded, [{ feature: 'SessionManager.verifyInjection', timestamp: '2026-11-05T10:00:00.000Z', narrative: 'Recovery keypress sent.', reason: 'SECRET-REASON' }]);
    const r = await signedGet(app, pair());
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ schemaVersion: 1, verdict: 'running', headline: 'Running normally.', uptime: '2h' });
    expect(r.body.issues[0]).toMatchObject({ id: 'SessionManager.verifyInjection', impact: 'internal', count: 1 });
    expect(JSON.stringify(r.body)).not.toContain('SECRET-REASON');
    expect(r.body).not.toHaveProperty('sessions');
  });

  it('the bearer reads it too', async () => {
    const { app } = setup(healthy);
    const r = await request(app).get(PATH).set('Authorization', 'Bearer tok-1');
    expect(r.status).toBe(200);
    expect(r.body.verdict).toBe('healthy');
  });

  it('refuses an MSP phone, an unsigned and a tampered request, a revoked phone and a POST', async () => {
    const { app, svc, pair } = setup(healthy);
    const msp = await signedGet(app, pair({ userId: 'justin', role: 'msp' }));
    expect(msp.status).toBe(403);
    expect((await request(app).get(PATH)).status).toBe(401);
    const owner = pair();
    const time = String(Date.now());
    const tampered = await request(app).get(PATH).set('X-Instar-Device', owner.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', owner.dev.sign(canonicalString(owner.id, HOST, 'GET', '/mobile/other', time, undefined)));
    expect(tampered.status).toBe(401);
    const revoked = pair();
    svc.devices.revoke(revoked.id, 'test');
    expect((await signedGet(app, revoked)).status).not.toBe(200);
    expect((await request(app).post(PATH).set('Authorization', 'Bearer tok-1').send({})).status).toBe(404);
  });

  it('a /health it cannot read is a 500 that says so, and the next read tries again', async () => {
    let up = false;
    const { app } = setup(async () => (up ? { status: 200, body: { status: 'ok' } } : { status: 503, body: null }));
    const down = await request(app).get(PATH).set('Authorization', 'Bearer tok-1');
    expect(down.status).toBe(500);
    expect(down.body).toEqual({ error: 'health-unavailable' });
    up = true;
    expect((await request(app).get(PATH).set('Authorization', 'Bearer tok-1')).status).toBe(200);
  });
});
