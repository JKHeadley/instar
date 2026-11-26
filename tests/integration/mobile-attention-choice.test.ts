/**
 * HTTP pipeline for Done and Ignore on a Needs-you item (docs/specs/mobile-attention-choices.md): the
 * production authMiddleware + deviceAuthenticator in front of the route, with a stand-in for the
 * dashboard's PATCH /attention/:id. An owner phone is allowed; an MSP phone, an unsigned request and a
 * phone calling the raw PATCH are refused.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { mountMobileAttentionChoiceRoutes } from '../../src/server/mobileAttentionChoiceRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const TOKEN = 'tok-integration-0123456789';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-attention-choice.test.ts' });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const svc = new MobilePairingService({ config: { projectName: 'echo', stateDir: dir, authToken: TOKEN, developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } } } as never, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' } as MobilePairingDeps);
  services.push(svc);
  const patched: Array<{ path: string; body: unknown }> = [];
  const items = new Set(['telegram-ingress:x:2026-11-06']);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => TOKEN, 'echo', undefined, deviceAuthenticator(svc)));
  const router = express.Router();
  mountMobileAttentionChoiceRoutes(router, {
    call: async (_m, p, body) => {
      patched.push({ path: p, body });
      const id = decodeURIComponent(p.replace('/attention/', ''));
      if (!items.has(id)) return { status: 404, body: { error: 'Attention item not found' } };
      items.delete(id);
      return { status: 200, body: { id } };
    },
    bearerOk: (req) => req.headers.authorization === `Bearer ${TOKEN}`,
  });
  app.use(router);
  app.patch('/attention/:id', (_req, res) => { res.json({ rawRoute: true }); });
  const pair = (person?: { userId: string; role: 'msp' }) => {
    const dev = makeDevice();
    const created = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
    if (!created.ok) throw new Error('setup');
    svc.devices.applyConfirm(created.device.id, { ok: true });
    return { dev, id: created.device.id };
  };
  return { app, owner: pair(), pair, patched };
}

let tick = 0;
function signed(app: express.Express, phone: { dev: ReturnType<typeof makeDevice>; id: string }, method: 'POST' | 'PATCH', p: string, body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  const t = String(Date.now() + (tick++ % 1000));
  const sig = phone.dev.sign(canonicalString(phone.id, HOST, method, p, t, raw));
  const q = (method === 'POST' ? request(app).post(p) : request(app).patch(p)).set('Content-Type', 'application/json');
  return q.set('X-Instar-Device', phone.id).set('X-Instar-Device-Time', t).set('X-Instar-Device-Sig', sig).send(raw.toString());
}

describe('Done and Ignore on a Needs-you item, through the device pipeline', () => {
  const id = 'telegram-ingress:x:2026-11-06';
  it('an owner phone settles a real item through the dashboard route; a second tap says it is gone', async () => {
    const c = setup();
    const r = await signed(c.app, c.owner, 'POST', `/mobile/attention/${id}/choice`, { choice: 'done' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, message: 'Marked done.' });
    expect(c.patched).toEqual([{ path: `/attention/${encodeURIComponent(id)}`, body: { status: 'DONE', resolution: 'Marked done from the owner\'s phone.' } }]);
    const again = await signed(c.app, c.owner, 'POST', `/mobile/attention/${id}/choice`, { choice: 'done' });
    expect(again.status).toBe(404);
    expect(again.body.message).toBe('This is already gone. Pull to refresh.');
  });
  it('an MSP phone, an unsigned request, and a phone on the raw PATCH are refused', async () => {
    const c = setup();
    const msp = c.pair({ userId: 'justin', role: 'msp' });
    expect((await signed(c.app, msp, 'POST', `/mobile/attention/${id}/choice`, { choice: 'done' })).status).toBe(403);
    expect((await request(c.app).post(`/mobile/attention/${id}/choice`).send({ choice: 'done' })).status).toBe(401);
    const raw = await signed(c.app, c.owner, 'PATCH', `/attention/${id}`, { status: 'DONE' });
    expect(raw.status).toBe(403);
    expect(raw.body.error).toBe('device-not-allowed');
    expect(c.patched).toEqual([]);
  });
});
