/**
 * HTTP pipeline for the phone's native console pages and file browser
 * (docs/specs/mobile-native-console-pages.md) through the production authMiddleware +
 * deviceAuthenticator: an owner phone and the bearer token are served; an MSP phone, a demoted phone, a
 * revoked phone, an unsigned or tampered request, the notification read token and a POST are refused,
 * and a refused phone causes no read.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { mountMobileConsolePagesRoutes, type MobileConsolePagesDeps } from '../../src/server/mobileConsolePagesRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-native-console-pages.test.ts:cleanup' });
});

const asked: string[] = [];
const ANSWERS: Record<string, { status: number; body: unknown }> = {
  '/ecosystem-ideas': { status: 200, body: { funnel: { seen: 1, adopted: 0, bands: { now: 0 } }, ideas: [], watchlist: [], proposals: [] } },
  '/queue-pace?scope=pool': { status: 200, body: { queues: [], sources: [] } },
  '/green-pr-automerge': { status: 200, body: { episodes: [], stuckRed: [] } },
  '/local-verify': { status: 200, body: { queue: [] } },
  '/feedback-factory/triage/summary': { status: 200, body: { counts: {} } },
  '/maturation/board?scope=pool': { status: 200, body: { features: [] } },
  '/api/files/list': { status: 200, body: { path: '', entries: [{ name: 'CLAUDE.md', type: 'file', size: 3 }, { name: 'keys', type: 'directory' }] } },
  '/api/files/list?path=docs%2Fa%20b': { status: 200, body: { path: 'docs/a b', entries: [] } },
  '/api/files/read?path=CLAUDE.md': { status: 200, body: { path: 'CLAUDE.md', content: 'hello', size: 5 } },
};
function deps(over: Partial<MobileConsolePagesDeps> = {}): MobileConsolePagesDeps {
  return {
    read: async (p) => { asked.push(p); return ANSWERS[p] ?? { status: 404, body: { error: 'nope' } }; },
    bearerOk: (req) => req.headers.authorization === 'Bearer tok-1',
    ...over,
  };
}

function setup(over: Partial<MobileConsolePagesDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } } } as never;
  const pdeps: MobilePairingDeps = { config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' };
  const svc = new MobilePairingService(pdeps);
  services.push(svc);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  const router = express.Router();
  mountMobileConsolePagesRoutes(router, deps(over));
  app.use(router);
  const pair = (person?: { userId: string; role: 'msp' }) => {
    const dev = makeDevice();
    const created = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
    if (!created.ok) throw new Error('setup');
    svc.devices.applyConfirm(created.device.id, { ok: true });
    return { dev, id: created.device.id };
  };
  const owner = pair();
  return { app, svc, dev: owner.dev, id: owner.id, pair };
}

let tick = 0;
function signedGet(c: { app: express.Express; dev: ReturnType<typeof makeDevice>; id: string }, p: string) {
  const time = String(Date.now() + (tick++ % 1000));
  const sig = c.dev.sign(canonicalString(c.id, HOST, 'GET', p, time, undefined));
  return request(c.app).get(p).set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
}


const PAGES = ['/mobile/ideas', '/mobile/pace', '/mobile/development', '/mobile/maturation'];
const ROUTES = [...PAGES, '/mobile/files', '/mobile/files/read?path=CLAUDE.md'];

describe('owner phone', () => {
  it('every page answers, and the bearer token reads the same', async () => {
    const c = setup();
    for (const p of ROUTES) {
      const r = await signedGet(c, p);
      expect(r.status, p).toBe(200);
      expect(r.body.schemaVersion, p).toBe(1);
      expect(r.body.state, p).toBe('ok');
      expect((await request(c.app).get(p).set('Authorization', 'Bearer tok-1')).status, p).toBe(200);
    }
  });

  it('a folder path is passed encoded, and a secret-shaped entry stays hidden', async () => {
    const c = setup();
    expect((await signedGet(c, '/mobile/files')).body.entries.map((e: { name: string }) => e.name)).toEqual(['CLAUDE.md']);
    expect((await signedGet(c, '/mobile/files?path=docs%2Fa%20b')).body.path).toBe('docs/a b');
  });

  it('a secret-shaped path is refused without being read', async () => {
    const c = setup();
    asked.length = 0;
    for (const p of ['/mobile/files?path=.instar%2Fkeys', '/mobile/files/read?path=.instar%2Fkeys%2Fa.txt']) {
      const r = await signedGet(c, p);
      expect(r.status, p).toBe(200);
      expect(r.body.state, p).toBe('refused');
    }
    expect(asked).toEqual([]);
  });

  it('a path that is not one string is refused, and read needs a path', async () => {
    const c = setup();
    expect((await signedGet(c, '/mobile/files?path=a&path=b')).status).toBe(400);
    expect((await signedGet(c, '/mobile/files/read')).status).toBe(400);
  });

  it('a read that throws says it could not read, with no raw error', async () => {
    const c = setup({ read: async () => { throw new Error('raw-secret /Users/x'); } });
    for (const p of ROUTES) {
      const r = await signedGet(c, p);
      expect(r.status, p).toBe(200);
      expect(r.body.state, p).toBe('unavailable');
      expect(JSON.stringify(r.body), p).not.toContain('raw-secret');
    }
  });

  it('a page is read once inside its cache window', async () => {
    let reads = 0;
    const c = setup({ read: async () => { reads++; return { status: 200, body: { queues: [] } }; } });
    await signedGet(c, '/mobile/pace');
    await signedGet(c, '/mobile/pace');
    expect(reads).toBe(1);
  });
});

describe('refused', () => {
  it('an MSP phone gets 403 owner-phone-required and nothing is read', async () => {
    const c = setup();
    const msp = c.pair({ userId: 'justin', role: 'msp' });
    asked.length = 0;
    for (const p of ROUTES) {
      const r = await signedGet({ app: c.app, dev: msp.dev, id: msp.id }, p);
      expect(r.status, p).toBe(403);
      expect(r.body.error).toBe('owner-phone-required');
    }
    expect(asked).toEqual([]);
  });

  it('a phone demoted from owner to MSP is refused on its next read', async () => {
    const c = setup();
    expect((await signedGet(c, '/mobile/pace')).status).toBe(200);
    c.svc.devices.setPerson(c.id, { userId: 'justin', role: 'msp' });
    expect((await signedGet(c, '/mobile/pace')).status).toBe(403);
  });

  it('a revoked phone, an unsigned request and no credentials are refused', async () => {
    const c = setup();
    for (const p of ROUTES) {
      expect((await request(c.app).get(p).set('X-Instar-Device', c.id)).status, p).toBe(401);
      expect((await request(c.app).get(p)).status, p).toBe(401);
    }
    c.svc.devices.revoke(c.id);
    for (const p of ROUTES) expect((await signedGet(c, p)).status, p).toBe(401);
  });

  it('a tampered file path fails the signature', async () => {
    const c = setup();
    const time = String(Date.now());
    const sig = c.dev.sign(canonicalString(c.id, HOST, 'GET', '/mobile/files/read?path=CLAUDE.md', time, undefined));
    const r = await request(c.app).get('/mobile/files/read?path=.env').set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    expect(r.status).toBe(401);
  });

  it('a POST to the read paths is refused by the device check', async () => {
    const c = setup();
    for (const p of [...PAGES, '/mobile/files', '/mobile/files/read']) {
      const time = String(Date.now());
      const raw = Buffer.from('{}');
      const sig = c.dev.sign(canonicalString(c.id, HOST, 'POST', p, time, raw));
      const r = await request(c.app).post(p).set('Content-Type', 'application/json').set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).send('{}');
      expect(r.status, p).toBe(403);
    }
  });
});
